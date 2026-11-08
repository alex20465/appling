/** The state of a remote repo's connection, as the rail shows it. */
export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'closed';

export interface Backoff {
    /** The first wait, in ms. */
    initial: number;
    /** Each wait is this many times the one before... */
    factor: number;
    /** ...up to this one. */
    max: number;
    /** Attempts after a drop before giving up (the state becomes `failed`, Retry starts over); 0 never gives up. */
    attempts: number;
}

export const BACKOFF: Backoff = { initial: 1000, factor: 2, max: 30000, attempts: 10 };

/** The wait before the attempt with this number (1 is the first retry), with up to `jitter` of it added or removed. */
export function backoffDelay(attempt: number, backoff: Backoff = BACKOFF, random = Math.random, jitter = 0.2): number {
    const base = Math.min(backoff.max, backoff.initial * backoff.factor ** Math.max(0, attempt - 1));
    return Math.round(base * (1 + (random() * 2 - 1) * jitter));
}

export interface ConnectionOptions {
    /** Opens the connection and everything on it; rejects when it could not. */
    connect(attempt: number): Promise<void>;
    /** Tears down what `connect` set up, before the next attempt or at the end. */
    teardown?(): Promise<void> | void;
    backoff?: Backoff;
    /** Called on every change of state, with the error of the last failed attempt. */
    onState?(state: ConnectionState, detail: { attempt: number, error?: string, retryIn?: number }): void;
    /** Timers and randomness, replaceable in tests. */
    setTimeout?(callback: () => void, ms: number): unknown;
    clearTimeout?(timer: unknown): void;
    random?(): number;
}

/**
 * The reconnect state machine of one remote repo:
 *
 * ```
 * connecting --ok--> connected --lost--> reconnecting --ok--> connected
 *     |                                   |  ^ (wait, backoff)
 *     +--error--> failed <---attempts out-+--+
 * failed --retry--> connecting;  any --close--> closed
 * ```
 *
 * The first connect fails straight away (a wrong host or path should say so, not spin). After a drop it retries with
 * exponential backoff until `attempts` run out. A loss reported while connecting or waiting is ignored.
 */
export class Connection {
    state: ConnectionState = 'closed';
    attempt = 0;
    error?: string;
    private timer?: unknown;
    /** Bumped by every start and close, so a late result of an old attempt changes nothing. */
    private generation = 0;
    private readonly backoff: Backoff;

    constructor(private readonly options: ConnectionOptions) {
        this.backoff = options.backoff ?? BACKOFF;
    }

    /** Connects for the first time (or again after `failed` or `closed`). */
    start(): Promise<void> {
        if (this.state === 'connecting' || this.state === 'connected' || this.state === 'reconnecting') return Promise.resolve();
        this.attempt = 0;
        return this.run('connecting');
    }

    /** Retry from `failed`; a no-op otherwise. */
    retry(): Promise<void> {
        return this.state === 'failed' || this.state === 'closed' ? this.start() : Promise.resolve();
    }

    /** The connection dropped (the transport, the IDE server's relay or a forwarded stream ended). */
    lost(reason?: string): void {
        if (this.state !== 'connected') return;
        this.error = reason;
        this.attempt = 0;
        this.schedule();
    }

    /** Ends it for good (the repo was closed). */
    async close(): Promise<void> {
        this.generation++;
        this.clear();
        const was = this.state;
        this.set('closed');
        if (was !== 'closed') await this.options.teardown?.();
    }

    private async run(state: 'connecting' | 'reconnecting'): Promise<void> {
        const generation = ++this.generation;
        this.set(state);
        try {
            await this.options.teardown?.();
            if (generation !== this.generation) return;
            await this.options.connect(this.attempt);
            if (generation !== this.generation) return;
            this.error = undefined;
            this.attempt = 0;
            this.set('connected');
        } catch (error) {
            if (generation !== this.generation) return;
            this.error = (error as Error).message;
            if (state === 'connecting') {
                await this.options.teardown?.();
                if (generation === this.generation) this.set('failed');
            } else this.schedule();
        }
    }

    private schedule(): void {
        this.attempt++;
        if (this.backoff.attempts && this.attempt > this.backoff.attempts) {
            this.generation++;
            Promise.resolve(this.options.teardown?.()).finally(() => this.set('failed'));
            return;
        }
        const delay = backoffDelay(this.attempt, this.backoff, this.options.random);
        this.set('reconnecting', delay);
        const generation = ++this.generation;
        this.clear();
        this.timer = (this.options.setTimeout ?? setTimeout)(() => {
            if (generation === this.generation) void this.run('reconnecting');
        }, delay);
    }

    private clear(): void {
        if (this.timer !== undefined) (this.options.clearTimeout ?? ((t: unknown) => clearTimeout(t as NodeJS.Timeout)))(this.timer);
        this.timer = undefined;
    }

    private set(state: ConnectionState, retryIn?: number): void {
        this.state = state;
        this.options.onState?.(state, { attempt: this.attempt, ...this.error ? { error: this.error } : {}, ...retryIn !== undefined ? { retryIn } : {} });
    }
}

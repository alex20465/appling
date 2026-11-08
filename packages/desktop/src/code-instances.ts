/**
 * When each repo's Code OSS instance runs. `lazy`: it starts the first time its code view opens and is suspended
 * (its process stopped) after the view was out of sight for the idle time; Code OSS restores its tabs from the
 * workspace storage when it starts again. `always`: it starts with the repo and runs until the repo closes.
 */
export type Lifecycle = 'lazy' | 'always';

export type InstanceStatus = 'stopped' | 'starting' | 'running' | 'suspended' | 'failed';

export interface InstanceHandle {
    close(): void | Promise<void>;
}

export interface InstanceState<H> {
    status: InstanceStatus;
    handle?: H;
    error?: string;
}

export interface Timers {
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(timer: unknown): void;
}

export interface CodeInstancesOptions<H extends InstanceHandle> {
    launch(repo: string): Promise<H>;
    lifecycle: Lifecycle;
    /** How long a lazy instance may stay out of sight before it is suspended. */
    idleMs: number;
    /** After every status change. */
    onChange?(repo: string, state: InstanceState<H>): void;
    timers?: Timers;
}

interface Entry<H> extends InstanceState<H> {
    visible: boolean;
    timer?: unknown;
    /** The start in flight, shared by every caller. */
    starting?: Promise<H>;
    /** Bumped by every stop, so a start that finishes after it is closed again. */
    generation: number;
}

/** The instances of every open repo, with their lifecycle; pure apart from `launch` and the timers. */
export class CodeInstances<H extends InstanceHandle> {
    private readonly entries = new Map<string, Entry<H>>();
    private readonly timers: Timers;

    constructor(private options: CodeInstancesOptions<H>) {
        this.timers = options.timers ?? { setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: timer => clearTimeout(timer as NodeJS.Timeout) };
    }

    get lifecycle(): Lifecycle {
        return this.options.lifecycle;
    }

    repos(): string[] {
        return [...this.entries.keys()];
    }

    get(repo: string): InstanceState<H> | undefined {
        const entry = this.entries.get(repo);
        return entry && { status: entry.status, handle: entry.handle, error: entry.error };
    }

    /** Registers an open repo; with `always` its instance starts now. */
    add(repo: string): void {
        if (this.entries.has(repo)) return;
        this.entries.set(repo, { status: 'stopped', visible: false, generation: 0 });
        if (this.options.lifecycle === 'always') this.start(repo).catch(() => undefined);
    }

    /** The repo closed: its instance stops. */
    async remove(repo: string): Promise<void> {
        const entry = this.entries.get(repo);
        if (!entry) return;
        this.entries.delete(repo);
        await this.halt(entry);
    }

    /** The running instance, started when needed (also a suspended or failed one); concurrent calls share a start. */
    start(repo: string): Promise<H> {
        const entry = this.entries.get(repo);
        if (!entry) return Promise.reject(new Error(`${repo} is not open.`));
        if (entry.status === 'running' && entry.handle) return Promise.resolve(entry.handle);
        if (entry.starting) return entry.starting;
        const generation = entry.generation;
        this.set(repo, entry, { status: 'starting', error: undefined });
        const starting = this.options.launch(repo).then(handle => {
            entry.starting = undefined;
            if (entry.generation !== generation || this.entries.get(repo) !== entry) {
                handle.close();
                throw new Error(`The code view of ${repo} was stopped while it started.`);
            }
            this.set(repo, entry, { status: 'running', handle });
            this.arm(repo, entry);
            return handle;
        }, (error: Error) => {
            entry.starting = undefined;
            if (entry.generation === generation) this.set(repo, entry, { status: 'failed', error: error.message });
            throw error;
        });
        entry.starting = starting;
        return starting;
    }

    /** Whether the repo's code view is on screen; a lazy instance out of sight is suspended after the idle time. */
    visible(repo: string, visible: boolean): void {
        const entry = this.entries.get(repo);
        if (!entry || entry.visible === visible) return;
        entry.visible = visible;
        this.arm(repo, entry);
    }

    /** The instance's process ended on its own. */
    exited(repo: string, handle: H, error: string): void {
        const entry = this.entries.get(repo);
        if (!entry || entry.handle !== handle) return;
        this.disarm(entry);
        this.set(repo, entry, { status: 'failed', handle: undefined, error });
    }

    /** Suspends an instance now (its next start restores its state). */
    async suspend(repo: string): Promise<void> {
        const entry = this.entries.get(repo);
        if (!entry || (entry.status !== 'running' && entry.status !== 'starting')) return;
        await this.halt(entry);
        this.set(repo, entry, { status: 'suspended' });
    }

    /** Applies a changed setting: `always` starts every instance and never suspends; `lazy` suspends those out of sight. */
    configure(lifecycle: Lifecycle, idleMs: number): void {
        this.options = { ...this.options, lifecycle, idleMs };
        for (const [repo, entry] of this.entries) {
            if (lifecycle === 'always' && entry.status !== 'running' && entry.status !== 'starting') this.start(repo).catch(() => undefined);
            this.arm(repo, entry);
        }
    }

    async closeAll(): Promise<void> {
        await Promise.all(this.repos().map(repo => this.remove(repo)));
    }

    /** Starts or clears the idle timer: only a running lazy instance out of sight counts down. */
    private arm(repo: string, entry: Entry<H>): void {
        this.disarm(entry);
        if (this.options.lifecycle !== 'lazy' || entry.visible || entry.status !== 'running') return;
        entry.timer = this.timers.setTimeout(() => {
            entry.timer = undefined;
            if (this.entries.get(repo) === entry && !entry.visible) this.suspend(repo);
        }, this.options.idleMs);
    }

    private disarm(entry: Entry<H>): void {
        if (entry.timer === undefined) return;
        this.timers.clearTimeout(entry.timer);
        entry.timer = undefined;
    }

    private async halt(entry: Entry<H>): Promise<void> {
        this.disarm(entry);
        entry.generation++;
        entry.starting = undefined;
        const handle = entry.handle;
        entry.handle = undefined;
        await handle?.close();
    }

    private set(repo: string, entry: Entry<H>, change: Partial<InstanceState<H>>): void {
        Object.assign(entry, change);
        if (this.entries.get(repo) === entry) this.options.onChange?.(repo, { status: entry.status, handle: entry.handle, error: entry.error });
    }
}

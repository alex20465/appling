/**
 * The status of a terminal as the host sees it from its output alone, so it is known while no app is attached:
 * `running`, `needsInput` after a notification (OSC 9 or OSC 777, which agents such as Claude Code and Codex send when
 * they wait for the user) until the next input, and `exited` with the exit status. Transport independent: a remote
 * host keeps the same status and reports it over its own connection.
 */
export type TerminalStatus =
    | { state: 'running', since: number }
    | { state: 'needsInput', since: number, notification: TerminalNotification }
    | { state: 'exited', since: number, code: number, signal?: number };

export interface TerminalNotification {
    /** Missing for OSC 9, which has only a body. */
    title?: string;
    body: string;
    source: 'osc9' | 'osc777';
}

/** Longer sequences are no notifications; they are skipped (an OSC 52 clipboard write or an image may be megabytes). */
const LIMIT = 16 * 1024;

/**
 * Finds the notifications in a terminal's output: `ESC ] 9 ; body BEL` (iTerm2, without ConEmu's numbered
 * subcommands such as `9;4` progress) and `ESC ] 777 ; notify ; title ; body BEL` (urxvt), each also ended by
 * `ESC \`. A sequence may be split over any number of chunks.
 */
export class NotificationScanner {
    /** The text of an open OSC sequence after its `ESC ]`; undefined outside of one. */
    private open?: string;
    private escape = false;

    feed(chunk: string): TerminalNotification[] {
        if (this.open === undefined && !this.escape && !chunk.includes('\x1b')) return [];
        const found: TerminalNotification[] = [];
        for (let i = 0; i < chunk.length; i++) {
            const c = chunk[i];
            if (this.open === undefined) {
                if (this.escape && c === ']') this.open = '';
                this.escape = c === '\x1b';
                continue;
            }
            if (this.escape) {
                this.escape = false;
                if (c === '\\') {
                    this.end(found);
                    continue;
                }
                // ESC without a backslash cancels the sequence; it may start another one
                this.open = undefined;
                this.escape = true;
                i--;
                continue;
            }
            if (c === '\x07') this.end(found);
            else if (c === '\x1b') this.escape = true;
            else if (c === '\x18' || c === '\x1a') this.open = undefined;
            else {
                let end = i;
                while (end < chunk.length && !'\x07\x1b\x18\x1a'.includes(chunk[end])) end++;
                this.open += chunk.slice(i, end);
                i = end - 1;
                // too long for a notification: drop the text but keep waiting for the end of the sequence
                if (this.open.length > LIMIT) this.open = '\0';
            }
        }
        return found;
    }

    private end(found: TerminalNotification[]): void {
        const notification = parseNotification(this.open ?? '');
        this.open = undefined;
        if (notification) found.push(notification);
    }
}

/** The notification of an OSC sequence's text (`9;body`, `777;notify;title;body`), if it is one. */
export function parseNotification(osc: string): TerminalNotification | undefined {
    if (osc.startsWith('9;')) {
        const body = osc.slice(2);
        // ConEmu's numbered subcommands (4 progress, 9 working directory, ...) are no notifications
        if (!body || /^\d+(?:;|$)/.test(body)) return undefined;
        return { body, source: 'osc9' };
    }
    if (osc.startsWith('777;notify;')) {
        const [title, ...body] = osc.slice('777;notify;'.length).split(';');
        return { ...title ? { title } : {}, body: body.join(';'), source: 'osc777' };
    }
    return undefined;
}

/** Follows one terminal's status: feed it the output, the input and the exit; each returns the new status on a change. */
export class StatusTracker {
    status: TerminalStatus;
    private readonly scanner = new NotificationScanner();

    constructor(private readonly now: () => number = Date.now) {
        this.status = { state: 'running', since: now() };
    }

    output(data: string): TerminalStatus | undefined {
        const notifications = this.scanner.feed(data);
        if (!notifications.length || this.status.state === 'exited') return undefined;
        // the last one counts: an agent that notifies twice waits for the second
        this.status = { state: 'needsInput', since: this.now(), notification: notifications.at(-1)! };
        return this.status;
    }

    /** Input from a user answers the waiting program. */
    input(): TerminalStatus | undefined {
        if (this.status.state !== 'needsInput') return undefined;
        this.status = { state: 'running', since: this.now() };
        return this.status;
    }

    exit(code: number, signal?: number): TerminalStatus {
        this.status = { state: 'exited', since: this.now(), code, ...signal ? { signal } : {} };
        return this.status;
    }
}

/** The status in a few words, for `appling-pty-host list` and the tray. */
export function describeStatus(status: TerminalStatus): string {
    if (status.state === 'running') return 'running';
    if (status.state === 'needsInput') return 'needs input';
    return `exited ${status.code}${status.signal ? ` (signal ${status.signal})` : ''}`;
}

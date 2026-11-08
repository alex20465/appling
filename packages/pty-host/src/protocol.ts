import { createConnection, type Socket } from 'node:net';
import type { TerminalStatus } from './status.js';

/** Bumped on every incompatible change; a client and a host of different versions refuse each other. */
export const PROTOCOL = 2;

/** A terminal as the host reports it. */
export interface TerminalInfo {
    id: string;
    /** Free label chosen by the client, such as the repo folder; `list` filters by it. */
    group?: string;
    title?: string;
    shell: string;
    args: string[];
    cwd: string;
    pid: number;
    cols: number;
    rows: number;
    /** Milliseconds since the epoch. */
    created: number;
    /** Set once the process ended; the terminal and its scrollback stay until killed. */
    exit?: { code: number, signal?: number };
    /** How many clients are attached right now. */
    attached: number;
    /** Free metadata given at spawn or by `update`, such as an agent session's preset and label. */
    meta?: Record<string, string>;
    /** Running, waiting for input after a notification, or exited; kept by the host also while no client is attached. */
    status: TerminalStatus;
}

export interface SpawnOptions {
    /** Defaults to `$SHELL` (`%COMSPEC%` on Windows). */
    shell?: string;
    args?: string[];
    cwd: string;
    /** The whole environment of the shell; the client library defaults it to its own. */
    env?: Record<string, string>;
    cols?: number;
    rows?: number;
    group?: string;
    title?: string;
    /** Lines kept above the screen, 10000 by default. */
    scrollback?: number;
    /**
     * Queue the output for the spawning client from the first byte on, until its `attach` (which follows right after),
     * so it misses nothing a program prints at once. `PtyHostClient.spawnAttached` does both.
     */
    attach?: boolean;
    /**
     * Free string metadata the host keeps and lists (an agent session's `preset` and `label`, ...). The host reads
     * two keys itself: `label` titles its desktop notifications, `notify: 'off'` turns them off for the terminal.
     */
    meta?: Record<string, string>;
}

/** Client to host. Messages with an `id` are requests and get exactly one response with that `id`. */
export type Request =
    | { type: 'hello', id: number, token: string, protocol: number }
    | { type: 'spawn', id: number, options: SpawnOptions }
    | { type: 'list', id: number, group?: string }
    | { type: 'attach', id: number, terminal: string, cols?: number, rows?: number }
    | { type: 'detach', id: number, terminal: string }
    | { type: 'resize', id: number, terminal: string, cols: number, rows: number }
    | { type: 'kill', id: number, terminal: string, signal?: string }
    | { type: 'shutdown', id: number }
    /** Merges into the terminal's metadata (`null` removes a key) and sets its title. */
    | { type: 'update', id: number, terminal: string, meta?: Record<string, string | null>, title?: string }
    /** Every terminal's changes from now on (`terminal`, `status`, `removed`); the result is the current list. */
    | { type: 'subscribe', id: number }
    | { type: 'unsubscribe', id: number }
    | { type: 'input', terminal: string, data: string };

/** Host to client: responses and the events of attached terminals. */
export type Message =
    | { type: 'response', id: number, ok: true, result?: unknown }
    | { type: 'response', id: number, ok: false, error: string }
    | { type: 'data', terminal: string, data: string }
    | { type: 'exit', terminal: string, code: number, signal?: number }
    /** For subscribed clients: a terminal's status changed. */
    | { type: 'status', terminal: string, status: TerminalStatus }
    /** For subscribed clients: a terminal was spawned or updated. */
    | { type: 'terminal', info: TerminalInfo }
    /** For subscribed clients: a terminal was killed and is gone. */
    | { type: 'removed', terminal: string };

export interface HelloResult { protocol: number, pid: number, version: string }
export interface AttachResult { terminal: TerminalInfo, scrollback: string }

/**
 * Newline delimited JSON over a stream. `JSON.stringify` escapes line breaks inside strings, so one line is one message.
 * Lines longer than `limit()` characters end the connection.
 */
export function readLines(socket: Socket, onMessage: (message: unknown) => void, limit: () => number): void {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
        buffer += chunk;
        let index: number;
        while ((index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index);
            buffer = buffer.slice(index + 1);
            if (!line) continue;
            let message: unknown;
            try {
                message = JSON.parse(line);
            } catch {
                socket.destroy();
                return;
            }
            onMessage(message);
            if (socket.destroyed || !socket.writable) return;
        }
        if (buffer.length > limit()) socket.destroy();
    });
}

export function send(socket: Socket, message: Message | Request): void {
    if (!socket.destroyed && socket.writable) socket.write(JSON.stringify(message) + '\n');
}

/** Whether something accepts connections on the socket. */
export function answers(path: string, timeout = 1000): Promise<boolean> {
    return new Promise(resolve => {
        const socket = createConnection(path);
        const done = (result: boolean) => {
            clearTimeout(timer);
            socket.destroy();
            resolve(result);
        };
        const timer = setTimeout(() => done(false), timeout);
        socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
    });
}

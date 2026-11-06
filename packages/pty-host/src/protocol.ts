import { createConnection, type Socket } from 'node:net';

/** Bumped on every incompatible change; a client and a host of different versions refuse each other. */
export const PROTOCOL = 1;

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
    | { type: 'input', terminal: string, data: string };

/** Host to client: responses and the events of attached terminals. */
export type Message =
    | { type: 'response', id: number, ok: true, result?: unknown }
    | { type: 'response', id: number, ok: false, error: string }
    | { type: 'data', terminal: string, data: string }
    | { type: 'exit', terminal: string, code: number, signal?: number };

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

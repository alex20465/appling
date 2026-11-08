import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { defaultDir, ensureDir, logPath, socketPath, tokenPath } from './paths.js';
import { answers, PROTOCOL, readLines, send, type AttachResult, type HelloResult, type Message, type Request, type SpawnOptions, type TerminalInfo } from './protocol.js';

export interface ConnectOptions {
    /** The host's folder, `defaultDir()` when left out. */
    dir?: string;
    /** Start a host when none answers (default); with `false` connecting fails instead. */
    start?: boolean;
    /** Options for a host this call starts. */
    host?: StartOptions;
}

export interface StartOptions {
    /** The Node binary; inside Electron its own executable, which runs as Node through `ELECTRON_RUN_AS_NODE`. */
    node?: string;
    /** The host's entry, `hostMain()` by default; a packaged app passes its bundled copy. */
    main?: string;
    /** The host's own environment. Shells get the environment of their spawn request. */
    env?: NodeJS.ProcessEnv;
    /** Milliseconds without clients and without running terminals before the host exits; 60000 by default, 0 never. */
    idleTimeout?: number;
    /** How long to wait for the host to answer, 10000 ms by default. */
    timeout?: number;
}

/** The host's entry, `appling-pty-host`. Resolves from `src/` and `out/` alike, to the built file. */
export function hostMain(): string {
    return fileURLToPath(new URL('../out/main.js', import.meta.url));
}

/**
 * Starts a host for the folder as a detached process in its own session, so it outlives the caller, and waits until
 * it answers. Its output goes to `pty-host.log` in the folder. When another host wins the start, that one is used.
 */
export async function startPtyHost(dir: string = defaultDir(), options: StartOptions = {}): Promise<void> {
    ensureDir(dir);
    const log = openSync(logPath(dir), 'a', 0o600);
    let exited: number | null | undefined;
    try {
        const child = spawn(options.node ?? process.execPath, [options.main ?? hostMain(), 'serve', '--dir', dir, '--idle-timeout', String(options.idleTimeout ?? 60000)], {
            detached: true,
            stdio: ['ignore', log, log],
            env: { ...options.env ?? process.env, ELECTRON_RUN_AS_NODE: '1' },
            windowsHide: true
        });
        child.once('exit', code => exited = code);
        child.once('error', () => exited = -1);
        child.unref();
    } finally {
        closeSync(log);
    }
    const deadline = Date.now() + (options.timeout ?? 10000);
    while (Date.now() < deadline) {
        if (await answers(socketPath(dir), 500)) return;
        if (exited !== undefined && exited !== 0) break;
        await new Promise(done => setTimeout(done, 50));
    }
    const tail = (() => {
        try {
            return readFileSync(logPath(dir), 'utf8').trim().split('\n').slice(-5).join('\n');
        } catch {
            return '';
        }
    })();
    throw new Error(`The pty host did not start${exited !== undefined ? ` (exit code ${exited})` : ''}.${tail ? `\n${tail}` : ''}`);
}

/** Connects to the folder's host, starting one when none answers unless `start` is `false`. */
export async function connectPtyHost(options: ConnectOptions = {}): Promise<PtyHostClient> {
    const dir = options.dir ?? defaultDir();
    try {
        return await PtyHostClient.connect(dir);
    } catch (error) {
        if (options.start === false || !isUnreachable(error)) throw error;
    }
    await startPtyHost(dir, options.host);
    return PtyHostClient.connect(dir);
}

function isUnreachable(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'EPIPE' || code === 'ECONNRESET';
}

interface Pending {
    resolve(result: unknown): void;
    reject(error: Error): void;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * One connection to the host. Closing it (or losing it) detaches its terminals; they keep running in the host.
 * Emits `close` when the connection ends.
 */
export class PtyHostClient extends EventEmitter<{ close: [] }> {
    private nextId = 1;
    private readonly pending = new Map<number, Pending>();
    private readonly terminals = new Map<string, AttachedTerminal>();
    /** The host's process id and version, from the hello. */
    host!: HelloResult;

    private constructor(private readonly socket: Socket) {
        super();
        readLines(socket, message => this.receive(message as Message), () => Infinity);
        socket.on('error', () => socket.destroy());
        socket.on('close', () => {
            const error = new Error('The connection to the pty host closed.');
            for (const pending of this.pending.values()) pending.reject(error);
            this.pending.clear();
            for (const terminal of this.terminals.values()) terminal.lost();
            this.terminals.clear();
            this.emit('close');
        });
    }

    /** Connects to a running host and authenticates with the token in its folder. */
    static async connect(dir: string = defaultDir()): Promise<PtyHostClient> {
        const socket = await new Promise<Socket>((resolve, reject) => {
            const socket = createConnection(socketPath(dir));
            socket.once('connect', () => {
                socket.off('error', reject);
                resolve(socket);
            });
            socket.once('error', reject);
        });
        const client = new PtyHostClient(socket);
        try {
            const token = readFileSync(tokenPath(dir), 'utf8').trim();
            client.host = await client.request({ type: 'hello', token, protocol: PROTOCOL }) as HelloResult;
        } catch (error) {
            socket.destroy();
            throw error;
        }
        return client;
    }

    get closed(): boolean {
        return this.socket.destroyed;
    }

    /** Starts a terminal; the environment defaults to this process's. */
    spawn(options: SpawnOptions): Promise<TerminalInfo> {
        return this.request({ type: 'spawn', options: { env: process.env as Record<string, string>, ...options } }) as Promise<TerminalInfo>;
    }

    /**
     * Starts a terminal and attaches to it, with its output from the first byte on: what a program prints at once
     * arrives as `data` too, not only in the scrollback.
     */
    async spawnAttached(options: SpawnOptions): Promise<AttachedTerminal> {
        const info = await this.spawn({ ...options, attach: true });
        return this.attach(info.id);
    }

    /** The host's terminals, those of one group when given, also the ended ones until they are killed. */
    list(group?: string): Promise<TerminalInfo[]> {
        return this.request({ type: 'list', group }) as Promise<TerminalInfo[]>;
    }

    /**
     * Attaches to a terminal: resolves with its screen and scrollback serialized as escape sequences, to be written
     * into a fresh xterm.js, then streams its output. Optionally resizes it first.
     */
    async attach(terminal: string, size?: { cols: number, rows: number }): Promise<AttachedTerminal> {
        if (this.terminals.has(terminal)) throw new Error(`Terminal ${terminal} is already attached on this connection.`);
        const attached = new AttachedTerminal(this, terminal);
        this.terminals.set(terminal, attached);
        try {
            const result = await this.request({ type: 'attach', terminal, ...size }) as AttachResult;
            attached.info = result.terminal;
            attached.scrollback = result.scrollback;
            return attached;
        } catch (error) {
            this.terminals.delete(terminal);
            throw error;
        }
    }

    write(terminal: string, data: string): void {
        send(this.socket, { type: 'input', terminal, data });
    }

    resize(terminal: string, cols: number, rows: number): Promise<void> {
        return this.request({ type: 'resize', terminal, cols, rows }) as Promise<void>;
    }

    /** Without a signal ends the terminal and removes it with its scrollback; with one only sends the signal. */
    async kill(terminal: string, signal?: string): Promise<void> {
        await this.request({ type: 'kill', terminal, signal });
        if (signal === undefined) this.terminals.delete(terminal);
    }

    async detach(terminal: string): Promise<void> {
        this.terminals.delete(terminal);
        await this.request({ type: 'detach', terminal });
    }

    /** Ends every terminal and the host. */
    shutdown(): Promise<void> {
        return this.request({ type: 'shutdown' }) as Promise<void>;
    }

    /** Closes this connection; the terminals keep running. */
    close(): void {
        this.socket.end();
    }

    private request(request: DistributiveOmit<Exclude<Request, { type: 'input' }>, 'id'>): Promise<unknown> {
        if (this.socket.destroyed) return Promise.reject(new Error('The connection to the pty host is closed.'));
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            send(this.socket, { ...request, id } as Request);
        });
    }

    private receive(message: Message): void {
        if (message.type === 'response') {
            const pending = this.pending.get(message.id);
            this.pending.delete(message.id);
            if (message.ok) pending?.resolve(message.result);
            else pending?.reject(new Error(message.error));
        } else if (message.type === 'data') {
            this.terminals.get(message.terminal)?.receive(message.data);
        } else if (message.type === 'exit') {
            this.terminals.get(message.terminal)?.ended({ code: message.code, signal: message.signal });
        }
    }
}

/**
 * A terminal attached on one connection. Output that arrives before the first `onData` listener is kept for it, so
 * nothing between the snapshot and the listener is lost.
 */
export class AttachedTerminal {
    info!: TerminalInfo;
    /** The screen and scrollback at attach time, as escape sequences for xterm.js. */
    scrollback = '';
    private buffered: string[] | undefined = [];
    private exitInfo?: { code: number, signal?: number };
    private readonly dataListeners = new Set<(data: string) => void>();
    private readonly exitListeners = new Set<(exit: { code: number, signal?: number }) => void>();

    constructor(private readonly client: PtyHostClient, readonly id: string) {}

    onData(listener: (data: string) => void): () => void {
        this.dataListeners.add(listener);
        if (this.buffered) {
            const buffered = this.buffered;
            this.buffered = undefined;
            for (const data of buffered) listener(data);
        }
        return () => this.dataListeners.delete(listener);
    }

    /** Called when the process ends, right away when it already has. `code` is -1 when the host lost the terminal. */
    onExit(listener: (exit: { code: number, signal?: number }) => void): () => void {
        this.exitListeners.add(listener);
        if (this.exitInfo) listener(this.exitInfo);
        return () => this.exitListeners.delete(listener);
    }

    write(data: string): void {
        this.client.write(this.id, data);
    }

    resize(cols: number, rows: number): Promise<void> {
        return this.client.resize(this.id, cols, rows);
    }

    detach(): Promise<void> {
        return this.client.detach(this.id);
    }

    kill(signal?: string): Promise<void> {
        return this.client.kill(this.id, signal);
    }

    /** @internal */
    receive(data: string): void {
        if (this.buffered) this.buffered.push(data);
        else for (const listener of this.dataListeners) listener(data);
    }

    /** @internal */
    ended(exit: { code: number, signal?: number }): void {
        if (this.exitInfo) return;
        this.exitInfo = exit;
        for (const listener of this.exitListeners) listener(exit);
    }

    /** @internal The connection closed: the terminal is detached, not ended. */
    lost(): void {
        this.dataListeners.clear();
        this.exitListeners.clear();
    }
}

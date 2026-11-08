import { spawn as spawnProcess } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { SerializeAddon } from '@xterm/addon-serialize';
import headless from '@xterm/headless';
import * as pty from 'node-pty';
import { notificationText, type Notifier } from './notifier.js';
import { ensureDir, socketPath, tokenPath } from './paths.js';
import { answers, PROTOCOL, readLines, send, type HelloResult, type Message, type Request, type SpawnOptions, type TerminalInfo } from './protocol.js';
import { StatusTracker, type TerminalStatus } from './status.js';
import { VERSION } from './version.js';

const { Terminal } = headless;
type Headless = InstanceType<typeof Terminal>;

const WINDOWS = process.platform === 'win32';
/** Before the hello a client may send only a short line; afterwards input chunks may be large pastes. */
const UNAUTHENTICATED_LIMIT = 4096;
const LINE_LIMIT = 16 * 1024 * 1024;

export interface HostOptions {
    dir: string;
    /** Exit after this many milliseconds without clients and without running terminals; 0 never. */
    idleTimeout?: number;
    log?(message: string): void;
    /**
     * Raises a desktop notification when a terminal needs input (OSC 9 or OSC 777) while no client is attached to it.
     * None by default: the command line passes the system's, tests a fake, a remote host none.
     */
    notifier?: Notifier;
    /**
     * The program that opens the app at a terminal when its notification is clicked, `{terminal}` standing for its id
     * (`['appling-desktop', '--session', '{terminal}']`). Without it a click does nothing.
     */
    open?: string[];
}

interface Client {
    socket: Socket;
    authenticated: boolean;
    /** Attached terminals; while an attach waits for its snapshot, the output that arrives meanwhile is queued. */
    attached: Map<string, string[] | undefined>;
    /** Whether it gets every terminal's changes (`subscribe`). */
    subscribed: boolean;
}

interface Session {
    info: Omit<TerminalInfo, 'attached' | 'status'>;
    status: StatusTracker;
    /** The `since` of the needs input status whose notification went out, so each one is raised once. */
    notified?: number;
    pty: pty.IPty;
    screen: Headless;
    serializer: SerializeAddon;
    clients: Set<Client>;
}

/**
 * The daemon: owns the ptys, mirrors each into a headless xterm for its scrollback and streams their output to the
 * attached clients. It listens on the folder's socket and accepts a client only after a hello with the folder's token.
 */
export class PtyHost {
    private server?: Server;
    private readonly sessions = new Map<string, Session>();
    private readonly clients = new Set<Client>();
    private token = '';
    private idleTimer?: NodeJS.Timeout;
    private closing?: Promise<void>;
    /** Resolves when the host has shut down. */
    readonly closed: Promise<void>;
    private resolveClosed!: () => void;

    constructor(private readonly options: HostOptions) {
        this.closed = new Promise(done => this.resolveClosed = done);
    }

    get socket(): string {
        return socketPath(this.options.dir);
    }

    /**
     * Writes a fresh token and listens. Resolves `false` without listening when another host already answers on the
     * socket; a stale socket file of a host that died is removed.
     */
    async listen(): Promise<boolean> {
        const { dir } = this.options;
        ensureDir(dir);
        // Two hosts started at once must not both remove the socket and listen: the lock folder lets one through.
        const lock = join(dir, 'lock');
        for (let attempt = 0; ; attempt++) {
            try {
                mkdirSync(lock);
                break;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
                if (Date.now() - statSync(lock).mtimeMs > 10000) rmSync(lock, { recursive: true, force: true });
                else if (attempt > 100) throw new Error(`${lock} stays locked.`);
                else await new Promise(done => setTimeout(done, 50));
            }
        }
        try {
            return await this.listenLocked();
        } finally {
            rmSync(lock, { recursive: true, force: true });
        }
    }

    private async listenLocked(): Promise<boolean> {
        const { dir } = this.options;
        if (await answers(this.socket)) return false;
        if (!WINDOWS) rmSync(this.socket, { force: true });
        this.token = randomBytes(32).toString('hex');
        const temp = `${tokenPath(dir)}.${process.pid}`;
        writeFileSync(temp, this.token, { mode: 0o600 });
        renameSync(temp, tokenPath(dir));
        const server = createServer(socket => this.accept(socket));
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(this.socket, () => {
                server.off('error', reject);
                resolve();
            });
        });
        if (!WINDOWS) chmodSync(this.socket, 0o600);
        this.server = server;
        this.log(`listening on ${this.socket} (pid ${process.pid})`);
        this.scheduleIdle();
        return true;
    }

    /** Kills every terminal, closes the socket and resolves `closed`. */
    close(): Promise<void> {
        this.closing ??= (async () => {
            clearTimeout(this.idleTimer);
            for (const session of this.sessions.values()) if (!session.info.exit) session.pty.kill();
            for (const session of this.sessions.values()) session.screen.dispose();
            this.sessions.clear();
            for (const client of this.clients) client.socket.end();
            if (this.server) await new Promise(done => this.server!.close(done));
            this.log('closed');
            this.resolveClosed();
        })();
        return this.closing;
    }

    private log(message: string): void {
        this.options.log?.(`${new Date().toISOString()} ${message}`);
    }

    private accept(socket: Socket): void {
        const client: Client = { socket, authenticated: false, attached: new Map(), subscribed: false };
        this.clients.add(client);
        const hello = setTimeout(() => client.authenticated || socket.destroy(), 5000);
        readLines(socket, message => this.handle(client, message as Request), () => client.authenticated ? LINE_LIMIT : UNAUTHENTICATED_LIMIT);
        socket.on('error', () => socket.destroy());
        socket.on('close', () => {
            clearTimeout(hello);
            this.clients.delete(client);
            for (const id of client.attached.keys()) {
                const session = this.sessions.get(id);
                session?.clients.delete(client);
                if (session) this.maybeNotify(session);
            }
            // Probes that never authenticate, such as `answers`, do not keep the host alive or reset its idle timer.
            if (client.authenticated) this.scheduleIdle();
        });
    }

    private handle(client: Client, request: Request): void {
        if (!client.authenticated) {
            if (request?.type !== 'hello' || typeof request.token !== 'string' || !sameToken(request.token, this.token)) {
                if (typeof (request as { id?: unknown })?.id === 'number') respond(client, (request as { id: number }).id, 'Wrong token.');
                client.socket.end();
                return;
            }
            if (request.protocol !== PROTOCOL) {
                respond(client, request.id, `The pty host speaks protocol ${PROTOCOL}, the client ${request.protocol}.`);
                client.socket.end();
                return;
            }
            client.authenticated = true;
            clearTimeout(this.idleTimer);
            return respond(client, request.id, undefined, { protocol: PROTOCOL, pid: process.pid, version: VERSION } satisfies HelloResult);
        }
        if (request.type === 'input') {
            const session = this.sessions.get(request.terminal);
            if (session && !session.info.exit && typeof request.data === 'string') this.input(session, request.data);
            return;
        }
        try {
            this.request(client, request);
        } catch (error) {
            respond(client, request.id, error instanceof Error ? error.message : String(error));
        }
    }

    private request(client: Client, request: Exclude<Request, { type: 'input' }>): void {
        switch (request.type) {
            case 'hello':
                return respond(client, request.id, 'Already authenticated.');
            case 'spawn': {
                const info = this.spawn(request.options);
                if (request.options.attach) {
                    // queued from the first byte on; the client's `attach` takes the queue over
                    client.attached.set(info.id, []);
                    this.sessions.get(info.id)!.clients.add(client);
                }
                return respond(client, request.id, undefined, info);
            }
            case 'list':
                return respond(client, request.id, undefined, [...this.sessions.values()]
                    .filter(s => request.group === undefined || s.info.group === request.group)
                    .map(describe));
            case 'attach': {
                const session = this.session(request.terminal);
                if (request.cols && request.rows) this.resize(session, request.cols, request.rows);
                // The snapshot is taken once the headless terminal has parsed everything written so far; output that
                // arrives in between is queued for this client and sent right after the snapshot.
                // a terminal this client spawned with `attach` has queued its output since the first byte
                const queue: string[] = client.attached.get(session.info.id) ?? [];
                client.attached.set(session.info.id, queue);
                session.clients.add(client);
                session.screen.write('', () => {
                    if (client.attached.get(session.info.id) !== queue) return;
                    respond(client, request.id, undefined, { terminal: describe(session), scrollback: session.serializer.serialize() });
                    for (const data of queue) send(client.socket, { type: 'data', terminal: session.info.id, data });
                    client.attached.set(session.info.id, undefined);
                    if (session.info.exit) send(client.socket, { type: 'exit', terminal: session.info.id, ...session.info.exit });
                });
                return;
            }
            case 'detach': {
                client.attached.delete(request.terminal);
                const session = this.sessions.get(request.terminal);
                session?.clients.delete(client);
                respond(client, request.id);
                if (session) this.maybeNotify(session);
                return;
            }
            case 'resize':
                this.resize(this.session(request.terminal), request.cols, request.rows);
                return respond(client, request.id);
            case 'kill': {
                const session = this.session(request.terminal);
                if (session.info.exit || request.signal === undefined) this.remove(session);
                else session.pty.kill(request.signal);
                return respond(client, request.id);
            }
            case 'update': {
                const session = this.session(request.terminal);
                if (request.meta && typeof request.meta === 'object') {
                    const meta = { ...session.info.meta };
                    for (const [key, value] of Object.entries(request.meta)) {
                        if (value === null) delete meta[key];
                        else if (typeof value === 'string') meta[key] = value;
                    }
                    session.info.meta = meta;
                }
                if (typeof request.title === 'string') session.info.title = request.title;
                respond(client, request.id, undefined, describe(session));
                this.broadcast({ type: 'terminal', info: describe(session) });
                return;
            }
            case 'subscribe':
                client.subscribed = true;
                return respond(client, request.id, undefined, [...this.sessions.values()].map(describe));
            case 'unsubscribe':
                client.subscribed = false;
                return respond(client, request.id);
            case 'shutdown':
                respond(client, request.id);
                void this.close();
                return;
            default:
                return respond(client, (request as { id: number }).id, `Unknown request ${(request as { type: string }).type}.`);
        }
    }

    private session(id: string): Session {
        const session = this.sessions.get(id);
        if (!session) throw new Error(`No terminal ${id}.`);
        return session;
    }

    private spawn(options: SpawnOptions): TerminalInfo {
        if (!options || typeof options.cwd !== 'string') throw new Error('spawn needs a cwd.');
        const shell = options.shell || (WINDOWS ? process.env.COMSPEC || 'powershell.exe' : options.env?.SHELL || process.env.SHELL || '/bin/sh');
        const args = options.args ?? [];
        const cols = positive(options.cols, 80), rows = positive(options.rows, 24);
        const env: Record<string, string> = { ...(options.env ?? process.env as Record<string, string>) };
        for (const [key, value] of Object.entries(options.addEnv ?? {})) {
            if (value === null) delete env[key];
            else if (typeof value === 'string') env[key] = value;
        }
        delete env.ELECTRON_RUN_AS_NODE;
        delete env.APPLING_PTY_HOST_DIR;
        env.TERM = 'xterm-256color';
        env.COLORTERM = 'truecolor';
        const child = pty.spawn(shell, args, { name: 'xterm-256color', cols, rows, cwd: options.cwd, env });
        const screen = new Terminal({ cols, rows, scrollback: options.scrollback ?? 10000, allowProposedApi: true });
        const serializer = new SerializeAddon();
        screen.loadAddon(serializer as never);
        const id = randomUUID();
        const session: Session = {
            info: { id, group: options.group, title: options.title, shell, args, cwd: options.cwd, pid: child.pid, cols, rows, created: Date.now(), ...stringRecord(options.meta) },
            status: new StatusTracker(), pty: child, screen, serializer, clients: new Set()
        };
        this.sessions.set(id, session);
        child.onData(data => {
            screen.write(data);
            const status = session.status.output(data);
            if (status) this.changed(session, status);
            for (const client of session.clients) {
                const queue = client.attached.get(id);
                if (queue) queue.push(data);
                else send(client.socket, { type: 'data', terminal: id, data });
            }
        });
        child.onExit(({ exitCode, signal }) => {
            session.info.exit = { code: exitCode, ...signal ? { signal } : {} };
            this.log(`terminal ${id} exited with ${exitCode}`);
            this.changed(session, session.status.exit(exitCode, signal || undefined));
            // Let the last output reach the screen and the clients before the exit.
            screen.write('', () => {
                for (const client of session.clients) {
                    if (!client.attached.get(id)) send(client.socket, { type: 'exit', terminal: id, ...session.info.exit! } satisfies Message);
                }
                this.scheduleIdle();
            });
        });
        this.log(`terminal ${id} started: ${shell} in ${options.cwd}`);
        this.broadcast({ type: 'terminal', info: describe(session) });
        return describe(session);
    }

    private resize(session: Session, cols: number, rows: number): void {
        cols = positive(cols, session.info.cols);
        rows = positive(rows, session.info.rows);
        if (cols === session.info.cols && rows === session.info.rows) return;
        session.info.cols = cols;
        session.info.rows = rows;
        session.screen.resize(cols, rows);
        if (!session.info.exit) session.pty.resize(cols, rows);
    }

    private remove(session: Session): void {
        this.sessions.delete(session.info.id);
        if (!session.info.exit) session.pty.kill();
        session.screen.dispose();
        for (const client of session.clients) {
            client.attached.delete(session.info.id);
            if (!session.info.exit) send(client.socket, { type: 'exit', terminal: session.info.id, code: -1 });
        }
        this.broadcast({ type: 'removed', terminal: session.info.id });
        this.scheduleIdle();
    }

    private input(session: Session, data: string): void {
        session.pty.write(data);
        const status = session.status.input();
        if (status) this.changed(session, status);
    }

    private changed(session: Session, status: TerminalStatus): void {
        this.broadcast({ type: 'status', terminal: session.info.id, status });
        this.maybeNotify(session);
    }

    /** Sends a message to every subscribed client. */
    private broadcast(message: Message): void {
        for (const client of this.clients) if (client.subscribed) send(client.socket, message);
    }

    /**
     * Raises the notification of a terminal that needs input once nobody is attached to it (also when the last client
     * detaches later); a click opens the app at it, a reply is typed into it.
     */
    private maybeNotify(session: Session): void {
        const status = session.status.status;
        const { notifier } = this.options;
        if (!notifier || this.closing || status.state !== 'needsInput' || session.clients.size || session.notified === status.since) return;
        if (session.info.meta?.notify === 'off') return;
        session.notified = status.since;
        const { title, body } = notificationText(status.notification, session.info);
        const id = session.info.id;
        this.log(`terminal ${id} needs input: notifying`);
        notifier.notify({ terminal: id, title, body, reply: true }).then(answer => {
            const current = this.sessions.get(id);
            if (!answer || !current || current.info.exit) return;
            if (answer.action === 'reply') {
                this.log(`terminal ${id}: answered from the notification`);
                this.input(current, `${answer.text}\r`);
            } else this.open(id);
        }, error => this.log(`notification of terminal ${id} failed: ${(error as Error).message}`));
    }

    /** Starts the app at the terminal with the `open` command. */
    private open(terminal: string): void {
        const [command, ...args] = (this.options.open ?? []).map(arg => arg.replaceAll('{terminal}', terminal));
        if (!command) return;
        const env = { ...process.env };
        // the host runs as Node inside Electron's binary; the app must not
        delete env.ELECTRON_RUN_AS_NODE;
        try {
            const child = spawnProcess(command, args, { detached: true, stdio: 'ignore', env });
            child.on('error', error => this.log(`opening the app failed: ${error.message}`));
            child.unref();
            this.log(`opening the app at terminal ${terminal}`);
        } catch (error) {
            this.log(`opening the app failed: ${(error as Error).message}`);
        }
    }

    private scheduleIdle(): void {
        clearTimeout(this.idleTimer);
        const timeout = this.options.idleTimeout ?? 0;
        if (!timeout || this.closing || [...this.clients].some(c => c.authenticated) || [...this.sessions.values()].some(s => !s.info.exit)) return;
        this.idleTimer = setTimeout(() => {
            this.log('idle, shutting down');
            void this.close();
        }, timeout);
        this.idleTimer.unref?.();
    }
}

function describe(session: Session): TerminalInfo {
    return { ...session.info, args: [...session.info.args], ...session.info.meta ? { meta: { ...session.info.meta } } : {}, attached: session.clients.size, status: session.status.status };
}

/** The string entries of a client's metadata, as `{ meta }`, or nothing. */
function stringRecord(meta: unknown): { meta?: Record<string, string> } {
    if (!meta || typeof meta !== 'object') return {};
    const entries = Object.entries(meta).filter(([, value]) => typeof value === 'string');
    return entries.length ? { meta: Object.fromEntries(entries) } : {};
}

function respond(client: Client, id: number, error?: string, result?: unknown): void {
    send(client.socket, error === undefined ? { type: 'response', id, ok: true, result } : { type: 'response', id, ok: false, error });
}

function sameToken(given: string, expected: string): boolean {
    const a = Buffer.from(given), b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

function positive(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 10000 ? value : fallback;
}

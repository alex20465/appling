import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { socketPath, tokenPath } from '@appling/pty-host';
import { startIdeProcess, type IdeProcess, type IdeProcessOptions } from '../ide-process.js';
import { Connection, type Backoff, type ConnectionState } from './connection.js';
import { startContainer, type ContainerStartOptions } from './container.js';
import { Forward } from './forward.js';
import { install, type Installed, type InstallOptions } from './install.js';
import type { RemoteLocation } from './location.js';
import { readyPort, RelayProcess } from './relay.js';
import type { ReverseForward } from './reverse.js';
import { agentScript, ContainerTransport, transportFor, type Transport, type TransportOptions } from './transport.js';

export interface RemoteRepoOptions {
    location: RemoteLocation;
    /** The transport; by default the one of the location (`transportFor`). */
    transport?: Transport;
    transportOptions?: TransportOptions;
    container?: ContainerStartOptions;
    install: Omit<InstallOptions, 'code' | 'onProgress'>;
    /** For the IDE server, as for a local repo (shared sessions, the app host, the rail status). */
    ide?: Omit<IdeProcessOptions, 'launch' | 'onExit' | 'node' | 'main' | 'env'>;
    /**
     * A local folder (0700) for the pty host's forwarded socket and token: `connectPtyHost({ dir, start: false })`
     * reaches the remote pty host through it as if it ran here.
     */
    ptyDir: string;
    /**
     * Only the pty host there, no IDE server: the tray mode (#18) follows the terminals and agents of a remote repo
     * while the app is closed. `onConnected` then gets no URL.
     */
    ptyOnly?: boolean;
    backoff?: Backoff;
    onState?(state: ConnectionState, detail: { attempt: number, error?: string, retryIn?: number }): void;
    /** Called after every (re)connect, with the stable local URL of the IDE server. */
    onConnected?(url: string, again: boolean): void;
    onProgress?(line: string): void;
    /** A reverse forward came back on another port there after a reconnect (its old one was still taken). */
    onReverse?(name: string, port: number): void;
}

/** A local port made reachable there (`reverse`), set up again after every reconnect. */
interface Reverse {
    local: number;
    /** The port there: the last one, which a reconnect asks for again. */
    port?: number;
    forward?: ReverseForward;
    pending?: Promise<number>;
}

/** The parts of a remote repo on the other side, through the transport, kept up by a reconnect state machine. */
export class RemoteRepo {
    readonly connection: Connection;
    readonly transport: Transport;
    /** The repo's folder there, known after the first connect. */
    root?: string;
    installed?: Installed;
    ide?: IdeProcess;
    /** Why the terminals do not run there, when they do not. */
    terminalsProblem?: string;
    private ideForward?: Forward;
    private ptyForward?: Forward;
    private stopLost?: () => void;
    private connections = 0;
    private readonly reverses = new Map<string, Reverse>();
    /** Between a connect that got the transport, the server and the pty host up and the next teardown. */
    private up = false;

    constructor(private readonly options: RemoteRepoOptions) {
        this.transport = options.transport ?? transportFor(options.location, {
            ...options.transportOptions,
            container: { ...options.transportOptions?.container, resolve: location => startContainer(location.folder, { ...options.container, onProgress: options.onProgress }) }
        });
        this.connection = new Connection({
            connect: () => this.connect(),
            teardown: () => this.teardown(),
            backoff: options.backoff,
            onState: (state, detail) => options.onState?.(state, detail)
        });
    }

    /** The stable local URL of the IDE server (the same after every reconnect); undefined before the first connect. */
    get url(): string | undefined {
        return this.ideForward?.url;
    }

    start(): Promise<void> {
        return this.connection.start();
    }

    retry(): Promise<void> {
        return this.connection.retry();
    }

    async close(): Promise<void> {
        await this.connection.close();
        await Promise.all([this.ideForward?.close(), this.ptyForward?.close()]);
        this.ideForward = this.ptyForward = undefined;
        await this.transport.close();
    }

    private async connect(): Promise<void> {
        const { onProgress } = this.options;
        onProgress?.(`Connecting to ${this.transport.label}…`);
        await this.transport.open();
        this.installed = await install(this.transport, { ...this.options.install, onProgress });
        this.root = this.remoteRoot(this.installed.probe.home);
        if (this.options.ptyOnly) {
            this.stopLost = this.transport.onLost(() => this.connection.lost(`The connection to ${this.transport.label} was lost.`));
            await this.startPtyHost();
            this.up = true;
            this.options.onConnected?.('', this.connections++ > 0);
            return;
        }
        this.ideForward ??= await Forward.listen();
        const forward = this.ideForward;
        const agent = this.installed.agent;
        onProgress?.(`Starting the IDE server on ${this.transport.label}…`);
        let ide: IdeProcess | undefined;
        ide = await startIdeProcess(this.root, {
            ...this.options.ide,
            launch: args => new RelayProcess(this.transport.spawn(agentScript(agent, ['ide', ...args, '--origin', forward.url])), message => {
                const port = readyPort(message);
                if (port === undefined) return message;
                forward.retarget(() => this.transport.stream({ port }), true);
                return { ...message as object, url: forward.url };
            }).asChild(),
            onExit: (code, stderr) => {
                if (this.ide === ide) this.connection.lost(`The IDE server ended with code ${code}.${stderr ? `\n${stderr.trim()}` : ''}`);
            }
        });
        this.ide = ide;
        this.stopLost = this.transport.onLost(() => this.connection.lost(`The connection to ${this.transport.label} was lost.`));
        await this.startPtyHost().catch(error => this.terminalsProblem = (error as Error).message);
        this.up = true;
        // the reverse forwards of the last connection, on their ports there when those are free again
        for (const [name, reverse] of this.reverses) {
            await this.establish(name, reverse).catch(error => onProgress?.(`The reverse forward ${name} to ${this.transport.label} failed: ${(error as Error).message}`));
        }
        this.options.onConnected?.(forward.url, this.connections++ > 0);
    }

    /**
     * Makes a port of this machine reachable on 127.0.0.1 there, under a name (`agents`, `code-bridge`), and again
     * after every reconnect, on the same port there when it is free (`preferred` for the first time, such as the port
     * an agent started before an app restart was given). Resolves with the port there; the same forward for the same
     * local port. Rejects while not connected.
     */
    async reverse(name: string, local: number, preferred?: number): Promise<number> {
        const known = this.reverses.get(name);
        if (known?.local === local) {
            if (known.forward) return known.forward.port;
            if (known.pending) return known.pending;
        }
        await known?.forward?.close().catch(() => undefined);
        const reverse: Reverse = { local, port: known?.port ?? preferred };
        this.reverses.set(name, reverse);
        if (!this.up) throw new Error(`${this.transport.label} is not connected.`);
        return this.establish(name, reverse);
    }

    /** The port there of a reverse forward, while it is up. */
    reversePort(name: string): number | undefined {
        return this.reverses.get(name)?.forward?.port;
    }

    private establish(name: string, reverse: Reverse): Promise<number> {
        reverse.pending ??= (async () => {
            const forward = await this.transport.reverse(reverse.local, reverse.port);
            if (this.reverses.get(name) !== reverse || !this.up) {
                await forward.close().catch(() => undefined);
                throw new Error(`${this.transport.label} is not connected.`);
            }
            const moved = reverse.port !== undefined && reverse.port !== forward.port;
            reverse.forward = forward;
            reverse.port = forward.port;
            // the process carrying it ended while the connection stays (`docker exec` of the agent): set it up again
            forward.onEnd(() => {
                if (reverse.forward !== forward) return;
                reverse.forward = undefined;
                setTimeout(() => {
                    if (this.up && this.reverses.get(name) === reverse && !reverse.forward) void this.establish(name, reverse).catch(() => undefined);
                }, 1000);
            });
            if (moved) this.options.onReverse?.(name, forward.port);
            return forward.port;
        })().finally(() => reverse.pending = undefined);
        return reverse.pending;
    }

    /** Starts (or finds) the pty host there and serves its socket and token in `ptyDir`, where `PtyHostClient.connect` looks. */
    private async startPtyHost(): Promise<void> {
        if (!this.installed!.terminals) throw new Error(`The server bundle has no node-pty for ${this.installed!.probe.platform}-${this.installed!.probe.arch}, so terminals do not run on ${this.transport.label}.`);
        const result = await this.transport.exec(agentScript(this.installed!.agent, ['pty-host']), { timeout: 30000 });
        if (result.code !== 0) throw new Error(`The pty host did not start on ${this.transport.label}: ${result.stderr.trim()}`);
        const { socket, token } = JSON.parse(result.stdout.trim().split('\n').pop()!) as { socket: string, token: string };
        mkdirSync(this.options.ptyDir, { recursive: true, mode: 0o700 });
        writeFileSync(tokenPath(this.options.ptyDir), token, { mode: 0o600 });
        const open = () => this.transport.stream({ socket });
        if (this.ptyForward) this.ptyForward.retarget(open, true);
        else this.ptyForward = await Forward.listen({ path: socketPath(this.options.ptyDir) }, open);
        this.terminalsProblem = undefined;
    }

    /**
     * Starts Code OSS there for the code view (installing it the first time) and forwards its port. Resolves with the
     * local port and the connection token; `close` stops it.
     */
    async startCode(key: string, env: Record<string, string> = {}): Promise<{ port: number, token: string, close(): Promise<void>, onExit(listener: (output: string) => void): void }> {
        if (this.connection.state !== 'connected' || !this.root) throw new Error(`${this.transport.label} is not connected.`);
        await install(this.transport, { ...this.options.install, code: true, onProgress: this.options.onProgress });
        const child = this.transport.spawn(agentScript(this.installed!.agent, ['code', this.root, key]));
        // the environment (the code bridge's URL and token there) goes over stdin, not into a command line others can read
        child.stdin!.on('error', () => undefined);
        child.stdin!.write(`${JSON.stringify({ env })}\n`);
        let output = '';
        child.stderr!.on('data', chunk => output = (output + chunk).slice(-8000));
        const { port, token } = await new Promise<{ port: number, token: string }>((resolve, reject) => {
            const lines = createInterface({ input: child.stdout! });
            lines.once('line', line => {
                try {
                    resolve(JSON.parse(line));
                } catch {
                    reject(new Error(`Code OSS on ${this.transport.label} said: ${line}`));
                }
            });
            child.once('exit', code => reject(new Error(`Code OSS on ${this.transport.label} ended with code ${code}.\n${output.trim()}`)));
        });
        const forward = await Forward.listen({}, () => this.transport.stream({ port }));
        return {
            port: forward.port!, token,
            close: async () => {
                child.stdin!.end();
                await forward.close();
            },
            onExit: listener => child.once('exit', () => listener(output))
        };
    }

    /** The repo's folder there: `~` paths in the home folder, the container's workspace folder. */
    private remoteRoot(home: string): string {
        const location = this.options.location;
        if (location.kind === 'container') return (this.transport as ContainerTransport).workspace ?? `/workspaces/${location.folder.split(/[\\/]/).pop()}`;
        if (location.path === '~') return home;
        return location.path.startsWith('~/') ? join(home, location.path.slice(2)).replace(/\\/g, '/') : location.path;
    }

    private async teardown(): Promise<void> {
        this.up = false;
        for (const reverse of this.reverses.values()) {
            const forward = reverse.forward;
            reverse.forward = undefined;
            await forward?.close().catch(() => undefined);
        }
        this.stopLost?.();
        this.stopLost = undefined;
        const ide = this.ide;
        this.ide = undefined;
        ide?.close();
        // the local ends stay, so the view keeps its URL; connections wait for the next target
        this.ideForward?.retarget(undefined, true);
        this.ptyForward?.retarget(undefined, true);
    }
}

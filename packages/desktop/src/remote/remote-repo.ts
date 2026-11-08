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
    backoff?: Backoff;
    onState?(state: ConnectionState, detail: { attempt: number, error?: string, retryIn?: number }): void;
    /** Called after every (re)connect, with the stable local URL of the IDE server. */
    onConnected?(url: string, again: boolean): void;
    onProgress?(line: string): void;
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
        this.options.onConnected?.(forward.url, this.connections++ > 0);
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
    async startCode(key: string): Promise<{ port: number, token: string, close(): Promise<void>, onExit(listener: (output: string) => void): void }> {
        if (this.connection.state !== 'connected' || !this.root) throw new Error(`${this.transport.label} is not connected.`);
        await install(this.transport, { ...this.options.install, code: true, onProgress: this.options.onProgress });
        const child = this.transport.spawn(agentScript(this.installed!.agent, ['code', this.root, key]));
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

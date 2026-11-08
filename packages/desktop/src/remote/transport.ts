import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex, type Readable } from 'node:stream';
import { describeLocation, type RepoLocation, type RemoteLocation } from './location.js';
import { stdioReverse, type ReverseForward } from './reverse.js';

/** Where a stream goes on the other side: a TCP port on its loopback, or a Unix socket. */
export type StreamTarget = { port: number } | { socket: string };

export interface ExecResult {
    code: number | null;
    stdout: string;
    stderr: string;
}

export interface ExecOptions {
    /** Bytes for the command's stdin, such as an archive to unpack. */
    input?: Buffer | Readable;
    /** Milliseconds before the command is killed; none by default. */
    timeout?: number;
}

/** The program that runs the remote side (`remote/agent.js` of the server bundle) and the Node binary that runs it, as paths there. */
export interface AgentCommand {
    node: string;
    agent: string;
}

/**
 * How Desktop reaches the machine a repo lives on. Everything that touches the repo's files runs there (the IDE
 * server, the pty host, Code OSS); the transport runs commands there and opens byte streams to its ports and sockets,
 * which `forward.ts` serves on local ports. The local folder is one implementation among the others.
 */
export interface Transport {
    readonly location: RepoLocation;
    /** For messages: `SSH shop`, `WSL Ubuntu`, `this computer`. */
    readonly label: string;
    /** Set once the server bundle is installed (`install.ts`); streams to Unix sockets and ports without `ssh -W` go through it. */
    agent?: AgentCommand;
    /** Opens the connection: the ssh control master, the dev container. Resolves when commands can run. */
    open(): Promise<void>;
    /** The command line that runs a POSIX shell script on the other side. */
    command(script: string): { file: string, args: string[] };
    /** Runs a script on the other side with its stdio piped. */
    spawn(script: string): ChildProcess;
    /** Runs a script to its end. */
    exec(script: string, options?: ExecOptions): Promise<ExecResult>;
    /** A byte stream to a port or socket on the other side; it ends when either end closes. */
    stream(target: StreamTarget): Duplex;
    /**
     * Makes a TCP port of this machine reachable on the other side's 127.0.0.1 (`reverse.ts`), on `preferred` there
     * when it is free; resolves with the port there.
     */
    reverse(localPort: number, preferred?: number): Promise<ReverseForward>;
    /** Whether the connection still works; false after a network drop. */
    alive(): Promise<boolean>;
    /** Calls back once when the connection ends on its own (the ssh master died). Returns the unsubscribe function. */
    onLost(listener: () => void): () => void;
    /** Ends the connection. The processes started with `nohup` or detached (the pty host) keep running there. */
    close(): Promise<void>;
}

/** Quotes a word for a POSIX shell. */
export function shellQuote(word: string): string {
    return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** A script that runs the agent with these arguments. */
export function agentScript(agent: AgentCommand, args: (string | number)[]): string {
    return [agent.node, agent.agent, ...args.map(String)].map(shellQuote).join(' ');
}

/** Runs a command line to its end, collecting its output. */
export function execFile(file: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
    return collect(spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }), options);
}

function collect(child: ChildProcess, options: ExecOptions): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        child.stdout!.on('data', chunk => stdout += chunk);
        child.stderr!.on('data', chunk => stderr += chunk);
        const timer = options.timeout ? setTimeout(() => child.kill('SIGKILL'), options.timeout) : undefined;
        child.once('error', error => {
            clearTimeout(timer);
            reject(error);
        });
        child.once('close', code => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr });
        });
        child.stdin!.on('error', () => undefined);
        if (Buffer.isBuffer(options.input)) child.stdin!.end(options.input);
        else if (options.input) (options.input as Readable).pipe(child.stdin!);
        else child.stdin!.end();
    });
}

/** A child process's stdout and stdin as one stream; destroying it ends the process. */
export function childStream(child: ChildProcess): Duplex {
    const duplex = Duplex.from({ readable: child.stdout!, writable: child.stdin! });
    const end = () => {
        if (child.exitCode === null && child.signalCode === null) child.kill();
    };
    duplex.once('close', end);
    child.once('close', () => duplex.destroy());
    child.once('error', error => duplex.destroy(error));
    return duplex;
}

/** The transports that run commands through a launcher (ssh, docker exec, wsl.exe). */
abstract class CommandTransport implements Transport {
    agent?: AgentCommand;
    protected readonly lost = new Set<() => void>();
    abstract readonly location: RepoLocation;
    abstract readonly label: string;
    abstract command(script: string): { file: string, args: string[] };
    abstract open(): Promise<void>;

    spawn(script: string): ChildProcess {
        const { file, args } = this.command(script);
        return spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    }

    exec(script: string, options: ExecOptions = {}): Promise<ExecResult> {
        return collect(this.spawn(script), options);
    }

    stream(target: StreamTarget): Duplex {
        if (!this.agent) throw new Error(`Streams to ${this.label} need the installed server.`);
        return childStream(this.spawn(agentScript(this.agent, ['bridge', 'port' in target ? String(target.port) : target.socket])));
    }

    /** Through the agent's `reverse` command, its connections multiplexed over its stdio. */
    reverse(localPort: number, preferred = 0): Promise<ReverseForward> {
        if (!this.agent) return Promise.reject(new Error(`Reverse forwards to ${this.label} need the installed server.`));
        return stdioReverse(this.spawn(agentScript(this.agent, ['reverse', preferred])), localPort);
    }

    async alive(): Promise<boolean> {
        try {
            return (await this.exec('true', { timeout: 10000 })).code === 0;
        } catch {
            return false;
        }
    }

    onLost(listener: () => void): () => void {
        this.lost.add(listener);
        return () => this.lost.delete(listener);
    }

    protected emitLost(): void {
        const listeners = [...this.lost];
        this.lost.clear();
        listeners.forEach(listener => listener());
    }

    async close(): Promise<void> {
        this.lost.clear();
    }
}

/** This computer, for local folders and tests: scripts run in `sh`, streams connect directly. */
export class LocalTransport extends CommandTransport {
    readonly label = 'this computer';
    constructor(readonly location: RepoLocation = { kind: 'local', path: process.cwd() }) {
        super();
    }

    async open(): Promise<void> {}

    command(script: string) {
        return { file: 'sh', args: ['-c', script] };
    }

    override stream(target: StreamTarget): Duplex {
        return netConnect('port' in target ? { host: '127.0.0.1', port: target.port } : { path: target.socket });
    }

    override async alive(): Promise<boolean> {
        return true;
    }
}

export interface SshOptions {
    /** The ssh binary; `ssh` from the PATH. */
    ssh?: string;
    /** More `ssh` arguments before the host, such as `-F <config>` or `-i <key>`. */
    args?: string[];
    /** Where the control socket goes; a 0700 folder under the temp folder by default (socket paths must stay short). */
    controlDir?: string;
    /** Seconds between keep alive probes; the connection counts as lost after 3 unanswered ones. 10 by default. */
    keepAlive?: number;
}

/** The ssh arguments that name the host: the user, the port and the alias or host name. */
export function sshTarget(location: Extract<RepoLocation, { kind: 'ssh' }>): string[] {
    return [...location.port ? ['-p', String(location.port)] : [], ...location.user ? ['-l', location.user] : [], location.host];
}

/**
 * The ssh command lines of a connection, one control master per host that every command and stream multiplexes over
 * (`-S`). `BatchMode` keeps ssh from asking for a password the app cannot type: keys, an agent or a certificate log in.
 */
export function sshArgs(location: Extract<RepoLocation, { kind: 'ssh' }>, control: string, options: SshOptions = {}) {
    const common = [...options.args ?? [], '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15'];
    const target = sshTarget(location);
    const keepAlive = String(options.keepAlive ?? 10);
    return {
        master: ['-M', '-N', '-S', control, '-o', 'ControlPersist=no', '-o', `ServerAliveInterval=${keepAlive}`, '-o', 'ServerAliveCountMax=3', ...common, ...target],
        check: ['-S', control, '-O', 'check', ...common, ...target],
        exit: ['-S', control, '-O', 'exit', ...common, ...target],
        /** A script through the remote user's login shell, which hands it to `sh` so fish or csh logins work too. */
        exec: (script: string) => ['-S', control, '-o', 'ControlMaster=no', ...common, ...target, `sh -c ${shellQuote(script)}`],
        /**
         * A reverse forward on the master (`-O forward -R`): the host's 127.0.0.1:<remote> (0 lets sshd pick one, which
         * ssh prints) to this machine's 127.0.0.1:<local>. `cancel` removes it again.
         */
        forward: (spec: string) => ['-S', control, '-O', 'forward', '-R', spec, ...common, ...target],
        cancel: (spec: string) => ['-S', control, '-O', 'cancel', '-R', spec, ...common, ...target],
        /** A stdio stream to a TCP port on the host's loopback (`ssh -W`), multiplexed over the master. */
        stream: (port: number) => ['-S', control, '-o', 'ControlMaster=no', ...common, '-W', `127.0.0.1:${port}`, ...target]
    };
}

/** A path for the control socket: short (Unix socket paths are limited to about 100 bytes) and in a folder only the user may enter. */
export function controlPath(location: Extract<RepoLocation, { kind: 'ssh' }>, dir?: string): string {
    const folder = dir ?? join(tmpdir(), `appling-ssh-${process.getuid?.() ?? 'user'}`);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    // one master per repo, since each repo reconnects on its own: the path is part of the key
    const key = createHash('sha256').update(`${location.user ?? ''}@${location.host}:${location.port ?? ''}${location.path}`).digest('hex').slice(0, 12);
    return join(folder, key);
}

/** An SSH host, over one control master. Ports are reached with `ssh -W`, Unix sockets through the agent. */
export class SshTransport extends CommandTransport {
    readonly label: string;
    private master?: ChildProcess;
    private readonly control: string;
    private readonly args: ReturnType<typeof sshArgs>;
    private readonly ssh: string;

    constructor(readonly location: Extract<RepoLocation, { kind: 'ssh' }>, options: SshOptions = {}) {
        super();
        this.label = describeLocation(location);
        this.ssh = options.ssh ?? 'ssh';
        this.control = controlPath(location, options.controlDir);
        this.args = sshArgs(location, this.control, options);
    }

    async open(): Promise<void> {
        if (this.master && this.master.exitCode === null && await this.check()) return;
        // a master that hangs on a dead network holds the control socket; a new one needs the path
        const stale = this.master;
        this.master = undefined;
        stale?.kill();
        rmSync(this.control, { force: true });
        const master = spawn(this.ssh, this.args.master, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
        this.master = master;
        let stderr = '';
        master.stderr!.on('data', chunk => stderr = (stderr + chunk).slice(-4000));
        let ended = false;
        master.once('exit', () => {
            ended = true;
            if (this.master === master) {
                this.master = undefined;
                this.emitLost();
            }
        });
        master.once('error', () => ended = true);
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
            if (ended) throw new Error(`ssh to ${this.label} failed: ${stderr.trim() || 'the connection closed'}`);
            if (await this.check()) return;
            await new Promise(done => setTimeout(done, 150));
        }
        master.kill();
        throw new Error(`ssh to ${this.label} did not connect within 30 s.${stderr ? `\n${stderr.trim()}` : ''}`);
    }

    private async check(): Promise<boolean> {
        try {
            return (await execFile(this.ssh, this.args.check, { timeout: 10000 })).code === 0;
        } catch {
            return false;
        }
    }

    command(script: string) {
        return { file: this.ssh, args: this.args.exec(script) };
    }

    override stream(target: StreamTarget): Duplex {
        if ('socket' in target) return super.stream(target);
        return childStream(spawn(this.ssh, this.args.stream(target.port), { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }));
    }

    override async alive(): Promise<boolean> {
        return !!this.master && this.master.exitCode === null && await this.check();
    }

    /**
     * `ssh -O forward -R` on the control master. A port that is still taken there (sshd holds the forward of a master
     * whose network went away until it times out) falls back to one sshd picks. The forward ends with the master.
     */
    override async reverse(localPort: number, preferred = 0): Promise<ReverseForward> {
        const master = this.master;
        if (!master) throw new Error(`${this.label} is not connected.`);
        const spec = (port: number) => `127.0.0.1:${port}:127.0.0.1:${localPort}`;
        let port = preferred;
        let result = await execFile(this.ssh, this.args.forward(spec(port)), { timeout: 15000 });
        if (result.code !== 0 && port) {
            port = 0;
            result = await execFile(this.ssh, this.args.forward(spec(port)), { timeout: 15000 });
        }
        if (result.code !== 0) throw new Error(`The reverse forward to ${this.label} failed: ${result.stderr.trim() || `exit code ${result.code}`}`);
        if (!port) port = Number(/\d+/.exec(result.stdout)?.[0]);
        if (!Number.isInteger(port) || port <= 0) throw new Error(`ssh did not tell the port of the reverse forward to ${this.label}: ${result.stdout.trim()}`);
        const ends = new Set<() => void>();
        let ended = false;
        master.once('exit', () => {
            ended = true;
            for (const listener of [...ends]) listener();
            ends.clear();
        });
        return {
            port,
            onEnd: listener => ended ? listener() : ends.add(listener),
            close: async () => {
                ends.clear();
                if (this.master === master && master.exitCode === null) await execFile(this.ssh, this.args.cancel(spec(port)), { timeout: 5000 }).catch(() => undefined);
            }
        };
    }

    /** Ends the master at once (also while the app quits), and with it every command and stream over it. */
    override async close(): Promise<void> {
        this.lost.clear();
        const master = this.master;
        this.master = undefined;
        master?.kill();
        rmSync(this.control, { force: true });
    }
}

export interface ContainerOptions {
    /** The docker binary; `docker` from the PATH (podman works as well). */
    docker?: string;
}

/** The `docker exec` command line of a script, as the dev container's user. */
export function dockerExecArgs(container: string, script: string, user?: string): string[] {
    return ['exec', '-i', ...user ? ['-u', user] : [], container, 'sh', '-c', script];
}

/**
 * A running container. `resolveContainer` brings it up (see `container.ts`, which reads devcontainer.json) and tells
 * the container's id, the user to run as and the repo's folder inside it.
 */
export class ContainerTransport extends CommandTransport {
    readonly label: string;
    container?: string;
    user?: string;
    /** The repo's folder inside the container, known after `open`. */
    workspace?: string;
    private readonly docker: string;
    private watcher?: ChildProcess;

    constructor(
        readonly location: Extract<RepoLocation, { kind: 'container' }>,
        private readonly resolveContainer: () => Promise<{ container: string, user?: string, workspace: string }>,
        options: ContainerOptions = {}
    ) {
        super();
        this.label = describeLocation(location);
        this.docker = options.docker ?? 'docker';
    }

    async open(): Promise<void> {
        const { container, user, workspace } = await this.resolveContainer();
        Object.assign(this, { container, user, workspace });
        // the container stopping is a lost connection: `docker wait` returns then
        this.watcher?.kill();
        const watcher = spawn(this.docker, ['wait', container], { stdio: 'ignore', windowsHide: true });
        this.watcher = watcher;
        watcher.once('exit', () => {
            if (this.watcher === watcher) {
                this.watcher = undefined;
                this.emitLost();
            }
        });
    }

    command(script: string) {
        if (!this.container) throw new Error(`${this.label} is not open.`);
        return { file: this.docker, args: dockerExecArgs(this.container, script, this.user) };
    }

    override async close(): Promise<void> {
        await super.close();
        const watcher = this.watcher;
        this.watcher = undefined;
        watcher?.kill();
    }
}

/** The `wsl.exe` command line of a script in a distribution (`--exec` skips the default shell's own parsing). */
export function wslArgs(distro: string, script: string): string[] {
    return ['-d', distro, '--exec', 'sh', '-c', script];
}

/** A WSL distribution, through `wsl.exe` (Windows only). */
export class WslTransport extends CommandTransport {
    readonly label: string;
    constructor(readonly location: Extract<RepoLocation, { kind: 'wsl' }>, private readonly wsl = 'wsl.exe') {
        super();
        this.label = describeLocation(location);
    }

    async open(): Promise<void> {
        const result = await this.exec('true', { timeout: 60000 });
        if (result.code !== 0) throw new Error(`WSL ${this.location.distro} did not start: ${result.stderr.trim() || `exit code ${result.code}`}`);
    }

    command(script: string) {
        return { file: this.wsl, args: wslArgs(this.location.distro, script) };
    }
}

export interface TransportOptions {
    ssh?: SshOptions;
    container?: ContainerOptions & { resolve(location: Extract<RepoLocation, { kind: 'container' }>): Promise<{ container: string, user?: string, workspace: string }> };
    wsl?: string;
}

/** The transport of a remote location. */
export function transportFor(location: RemoteLocation, options: TransportOptions = {}): Transport {
    switch (location.kind) {
        case 'ssh': return new SshTransport(location, options.ssh);
        case 'wsl': return new WslTransport(location, options.wsl);
        case 'container': {
            const resolveContainer = options.container?.resolve;
            if (!resolveContainer) throw new Error('No way to start dev containers was given.');
            return new ContainerTransport(location, () => resolveContainer(location), options.container);
        }
    }
}

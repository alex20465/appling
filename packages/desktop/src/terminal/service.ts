import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { connectPtyHost, type AttachedTerminal, type ConnectOptions, type PtyHostClient, type TerminalInfo } from '@appling/pty-host';
import { asset } from './assets.js';
import type { Profiles, TerminalProfile } from './profiles.js';
import { TerminalRegistry, type RepoTerminals } from './registry.js';
import { DEFAULT_TERMINAL_SETTINGS, type TerminalSettings } from './settings.js';
import { injectShellIntegration, ShellIntegration, type CommandRecord, type IntegrationEvent, type Notification } from './shell-integration.js';

/** The integration scripts, copied next to the built module. */
export const SCRIPTS = asset('scripts');

export interface TerminalServiceOptions {
    /** How to reach the pty host (its folder, how to start it). */
    host?: ConnectOptions;
    /** Where the tabs and splits are kept between starts (`terminals.json`); in memory only when left out. */
    registryFile?: string;
    /** The current settings; read again for every new terminal. */
    settings?(): TerminalSettings;
    /** The profiles for a repo's new terminals. */
    profiles?(repo: string): Profiles;
    /** The environment terminals start from; this process's by default. */
    env?: NodeJS.ProcessEnv;
    /** The folder of the shell integration scripts. */
    scripts?: string;
    /** The app's version, for `TERM_PROGRAM_VERSION`. */
    version?: string;
}

export interface CreateOptions {
    /** A profile name; the default profile when left out. */
    profile?: string;
    /** Next to the focused terminal of the shown tab instead of in a new tab. */
    split?: boolean;
    /** The tab's name; the profile's or the command's name when left out. */
    name?: string;
    /** Runs this program instead of a shell (an agent such as `claude`); its exit ends the terminal. */
    command?: string;
    args?: string[];
    /** Added to the environment; `null` removes a variable. */
    env?: Record<string, string | null>;
    /** The working directory; the repo by default. */
    cwd?: string;
    cols?: number;
    rows?: number;
}

/** What the view and the API know about a terminal. */
export interface TerminalState {
    id: string;
    repo: string;
    /** The tab's label: the given name, else the profile or program, else the shell's name. */
    name: string;
    shell: string;
    pid: number;
    /** The working directory, followed through shell integration. */
    cwd: string;
    /** Whether it runs a program given with `command` rather than an interactive shell. */
    command: boolean;
    /** Whether its shell sends shell integration marks. */
    integration: boolean;
    running?: CommandRecord;
    last?: CommandRecord;
    exit?: { code: number, signal?: number };
}

interface Live {
    info: TerminalInfo;
    attached?: AttachedTerminal;
    integration: ShellIntegration;
    command: boolean;
    unsubscribe: (() => void)[];
    /** While the view asks for a fresh snapshot the output goes to it only after the snapshot. */
    paused: boolean;
}

type Events = {
    /** Output of a terminal (after a snapshot handed out by `snapshot`). */
    data: [id: string, data: string];
    exit: [id: string, exit: { code: number, signal?: number }];
    /** Shell integration marks and notifications, parsed. */
    event: [id: string, event: IntegrationEvent];
    notification: [id: string, notification: Notification];
    /** The tabs, splits, names or states of a repo's terminals changed. */
    changed: [repo: string];
};

/**
 * The terminals of every repo, in the pty host: starts them with a profile and shell integration, keeps one
 * attachment per terminal for this process (its output, marks and exit go out as events), tracks tabs and splits in
 * the registry and finds the host's terminals of a repo again after a restart. Electron free, so it is tested
 * against a real host; `panel.ts` wires it to the views.
 */
export class TerminalService extends EventEmitter<Events> {
    private client?: PtyHostClient;
    private connecting?: Promise<PtyHostClient>;
    readonly registry: TerminalRegistry;
    private readonly live = new Map<string, Live>();
    private readonly opened = new Set<string>();

    constructor(private readonly options: TerminalServiceOptions = {}) {
        super();
        this.registry = options.registryFile && existsSync(options.registryFile)
            ? TerminalRegistry.from(safeJson(readFileSync(options.registryFile, 'utf8')))
            : new TerminalRegistry();
    }

    private settings(): TerminalSettings {
        return this.options.settings?.() ?? DEFAULT_TERMINAL_SETTINGS;
    }

    /** The connection to the pty host, made (and the host started) on first use and again after it was lost. */
    async connection(): Promise<PtyHostClient> {
        if (this.client && !this.client.closed) return this.client;
        this.connecting ??= connectPtyHost(this.options.host).then(client => {
            this.client = client;
            this.connecting = undefined;
            client.on('close', () => {
                if (this.client !== client) return;
                this.client = undefined;
                for (const live of this.live.values()) live.attached = undefined;
            });
            return client;
        }, error => {
            this.connecting = undefined;
            throw error;
        });
        return this.connecting;
    }

    /**
     * Finds the repo's terminals in the host (also after an app restart or a crash), drops the ones it no longer has
     * from the tabs, gives the others a tab and attaches them. With `endWithApp` the terminals left from a run that
     * did not end them (a crash) are ended instead.
     */
    async openRepo(repo: string): Promise<void> {
        if (this.opened.has(repo)) return;
        this.opened.add(repo);
        const client = await this.connection();
        const infos = await client.list(repo);
        if (this.settings().endWithApp) {
            for (const info of infos.filter(i => !this.live.has(i.id))) await client.kill(info.id).catch(() => undefined);
            const ours = [...this.live.values()].filter(live => live.info.group === repo).map(live => live.info.id);
            if (this.registry.reconcile(repo, ours)) this.persist(repo);
            return;
        }
        // ended terminals stay in the host until killed: an unknown ended one goes, a known one keeps its output to be read
        const known = new Set(this.registry.terminals(repo));
        for (const info of infos.filter(i => i.exit && !known.has(i.id))) await client.kill(info.id).catch(() => undefined);
        const kept = infos.filter(info => !info.exit || known.has(info.id));
        const changed = this.registry.reconcile(repo, kept.map(info => info.id));
        // after a restart only the executable tells a shell from a program started with `command`
        for (const info of kept) await this.track(info, !isShell(info));
        if (changed) this.persist(repo);
        else this.emit('changed', repo);
    }

    /** Starts a terminal in the repo with a profile (a shell) or a command, and shows it. */
    async create(repo: string, options: CreateOptions = {}, spawned?: (id: string) => void): Promise<TerminalState> {
        const client = await this.connection();
        const settings = this.settings();
        const profiles = this.options.profiles?.(repo);
        const profile: TerminalProfile | undefined = options.command ? undefined
            : profiles?.profiles.find(p => p.name === (options.profile ?? settings.defaultProfile ?? profiles.default)) ?? profiles?.profiles[0];
        if (options.profile && !options.command && profile?.name !== options.profile) throw new Error(`There is no terminal profile "${options.profile}".`);
        const env = terminalEnv(this.options.env ?? process.env, [profile?.env, options.env], this.options.version);
        let launch = { shell: options.command ?? profile?.path ?? env.SHELL ?? '/bin/sh', args: options.command ? options.args ?? [] : profile?.args ?? [], env };
        if (!options.command && settings.shellIntegration) launch = injectShellIntegration(launch, this.options.scripts ?? SCRIPTS);
        const name = options.name ?? (options.command ? basename(options.command) : profile?.name ?? basename(launch.shell));
        // attached from the first byte, so the scanner sees the first prompt's marks and a program's first notification
        const attached = await client.spawnAttached({
            shell: launch.shell, args: launch.args, env: launch.env, cwd: options.cwd ?? repo,
            cols: options.cols, rows: options.rows, group: repo, title: name, scrollback: settings.scrollback
        });
        const info = attached.info;
        this.opened.add(repo);
        this.registry.add(repo, info.id, { split: options.split, name: options.name ?? (options.command ? name : undefined) });
        spawned?.(info.id);
        await this.track(info, !!options.command, attached);
        this.persist(repo);
        return this.state(info.id)!;
    }

    /** Attaches this process to a terminal and follows its output, marks and exit. */
    private async track(info: TerminalInfo, command: boolean, attached?: AttachedTerminal): Promise<void> {
        const known = this.live.get(info.id);
        const live: Live = known ?? { info, integration: new ShellIntegration(info.cwd), command, unsubscribe: [], paused: false };
        this.live.set(info.id, live);
        if (live.attached) return;
        attached ??= await (await this.connection()).attach(info.id);
        live.info = attached.info;
        this.listen(live, attached);
        if (!live.paused) live.unsubscribe.push(attached.onData(data => this.output(live, data)));
    }

    private listen(live: Live, attached: AttachedTerminal): void {
        for (const stop of live.unsubscribe) stop();
        live.unsubscribe = [];
        live.attached = attached;
        live.unsubscribe.push(attached.onExit(exit => this.ended(live, exit)));
    }

    private output(live: Live, data: string): void {
        const id = live.info.id;
        for (const event of live.integration.feed(data)) {
            this.emit('event', id, event);
            if (event.type === 'notification') this.emit('notification', id, event.notification);
            if (event.type === 'commandStarted' || event.type === 'commandFinished' || event.type === 'cwd') {
                const repo = this.registry.repoOf(id);
                if (repo) this.emit('changed', repo);
            }
        }
        this.emit('data', id, data);
    }

    private ended(live: Live, exit: { code: number, signal?: number }): void {
        const id = live.info.id;
        // -1 also arrives when the terminal was killed through `kill`, which already removed it
        if (live.info.exit && exit.code === -1) return;
        live.info = { ...live.info, exit };
        this.emit('exit', id, exit);
        const repo = this.registry.repoOf(id);
        // a shell that ends cleanly (`exit`, Ctrl+D) closes its tab, as in VS Code; a failed one or a program stays to be read
        if (!live.command && exit.code === 0) void this.kill(id);
        else if (repo) this.emit('changed', repo);
    }

    /**
     * Detaches and attaches again, for a view that (re)opens the terminal: resolves with the screen and scrollback as
     * escape sequences; the output after it follows as `data` events once `resume` is called.
     */
    async snapshot(id: string, size?: { cols: number, rows: number }): Promise<{ scrollback: string, resume(): void }> {
        const live = this.live.get(id);
        if (!live) throw new Error(`No terminal ${id}.`);
        const client = await this.connection();
        live.paused = true;
        try {
            if (live.attached) await live.attached.detach().catch(() => undefined);
            live.attached = undefined;
            const attached = await client.attach(id, size);
            live.info = { ...attached.info, ...live.info.exit && !attached.info.exit ? { exit: live.info.exit } : {} };
            this.listen(live, attached);
            return {
                scrollback: attached.scrollback,
                resume: () => {
                    live.paused = false;
                    if (live.attached === attached) live.unsubscribe.push(attached.onData(data => this.output(live, data)));
                }
            };
        } catch (error) {
            live.paused = false;
            throw error;
        }
    }

    write(id: string, data: string): void {
        this.live.get(id)?.attached?.write(data);
    }

    async resize(id: string, cols: number, rows: number): Promise<void> {
        const live = this.live.get(id);
        if (!live?.attached || live.info.exit) return;
        await live.attached.resize(cols, rows).catch(() => undefined);
        live.info = { ...live.info, cols, rows };
    }

    /** Ends a terminal and closes its pane. */
    async kill(id: string): Promise<void> {
        const live = this.live.get(id);
        if (live) {
            for (const stop of live.unsubscribe) stop();
            this.live.delete(id);
        }
        const repo = this.registry.remove(id);
        if (repo) this.persist(repo);
        const client = await this.connection().catch(() => undefined);
        await client?.kill(id).catch(() => undefined);
    }

    /** Sends a signal (`SIGINT`, ...) without closing the pane. */
    async signal(id: string, signal: string): Promise<void> {
        await (await this.connection()).kill(id, signal);
    }

    /** Ends every terminal of a repo and forgets its tabs (the repo was closed). */
    async closeRepo(repo: string): Promise<void> {
        this.opened.delete(repo);
        const terminals = this.registry.removeRepo(repo);
        this.save();
        await Promise.all(terminals.map(id => this.kill(id)));
    }

    /** Ends the terminals of every repo, for `endWithApp`. */
    async endAll(): Promise<void> {
        const ids = [...new Set([...this.live.keys(), ...this.registry.all().flatMap(repo => this.registry.terminals(repo))])];
        await Promise.all(ids.map(id => this.kill(id)));
    }

    /** Closes the connection; the terminals keep running in the host. */
    dispose(): void {
        this.client?.close();
        this.client = undefined;
    }

    state(id: string): TerminalState | undefined {
        const live = this.live.get(id);
        const repo = this.registry.repoOf(id) ?? live?.info.group;
        if (!live || !repo) return undefined;
        const names = this.registry.get(repo).names;
        return {
            id, repo,
            name: names[id] ?? live.info.title ?? basename(live.info.shell),
            shell: live.info.shell,
            pid: live.info.pid,
            cwd: live.integration.cwd ?? live.info.cwd,
            command: live.command,
            integration: live.integration.active,
            ...live.integration.running ? { running: live.integration.running } : {},
            ...live.integration.commands.length ? { last: live.integration.commands.at(-1) } : {},
            ...live.info.exit ? { exit: live.info.exit } : {}
        };
    }

    /** The repo's tabs and splits with the state of each terminal. */
    layout(repo: string): RepoTerminals & { terminals: Record<string, TerminalState> } {
        const entry = this.registry.get(repo);
        const terminals = Object.fromEntries(this.registry.terminals(repo).map(id => [id, this.state(id)]).filter(([, s]) => s)) as Record<string, TerminalState>;
        return { ...entry, terminals };
    }

    /** The commands a terminal ran, from its shell integration marks, the oldest first. */
    commands(id: string): CommandRecord[] {
        return [...this.live.get(id)?.integration.commands ?? []];
    }

    /** Changes the registry through `change` and saves it when it reports a change. */
    update(repo: string, change: (registry: TerminalRegistry) => boolean): boolean {
        if (!change(this.registry)) return false;
        this.persist(repo);
        return true;
    }

    /**
     * For agent sessions (#10): starts a named terminal running `command` with extra environment in the repo and
     * hands back a handle that reports its notifications (OSC 9, OSC 777), finished commands and exit status.
     */
    async createSession(repo: string, options: CreateOptions & { name: string, command: string }): Promise<TerminalSession> {
        let session: TerminalSession | undefined;
        // the session listens from the spawn on, so not even the first output of the program is missed
        await this.create(repo, options, id => session = new TerminalSession(this, id, repo));
        return session!;
    }

    private persist(repo: string): void {
        this.save();
        this.emit('changed', repo);
    }

    private save(): void {
        const file = this.options.registryFile;
        if (!file) return;
        try {
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, `${JSON.stringify(this.registry, null, 2)}\n`);
        } catch {
            // the arrangement is then rebuilt from the host at the next start
        }
    }
}

/**
 * A terminal started for an agent session. It records its notifications and exit from the spawn on; listeners added
 * later get the recorded ones first.
 */
export class TerminalSession {
    /** Every OSC 9 and OSC 777 notification so far. */
    readonly notifications: Notification[] = [];
    exit?: { code: number, signal?: number };
    private readonly stops: (() => void)[] = [];

    constructor(private readonly service: TerminalService, readonly id: string, readonly repo: string) {
        this.stops.push(this.on('notification', (notification: Notification) => this.notifications.push(notification)));
        this.stops.push(this.on('exit', (exit: { code: number, signal?: number }) => this.exit = exit));
    }

    get state(): TerminalState | undefined {
        return this.service.state(this.id);
    }

    private on<T>(event: 'data' | 'exit' | 'event' | 'notification', listener: (value: T) => void): () => void {
        const wrapped = ((id: string, value: T) => {
            if (id === this.id) listener(value);
        }) as never;
        this.service.on(event, wrapped);
        return () => this.service.off(event, wrapped);
    }

    onData(listener: (data: string) => void): () => void {
        return this.on('data', listener);
    }

    /** OSC 9 (`ESC ] 9 ; body BEL`) and OSC 777 (`ESC ] 777 ; notify ; title ; body BEL`) notifications, the earlier ones first. */
    onNotification(listener: (notification: Notification) => void): () => void {
        for (const notification of this.notifications) listener(notification);
        return this.on('notification', listener);
    }

    /** Shell integration marks (commands, working directory), notifications and progress, from now on. */
    onEvent(listener: (event: IntegrationEvent) => void): () => void {
        return this.on('event', listener);
    }

    /** The exit status of the program; called right away when it has already ended. */
    onExit(listener: (exit: { code: number, signal?: number }) => void): () => void {
        if (this.exit) {
            listener(this.exit);
            return () => undefined;
        }
        return this.on('exit', listener);
    }

    write(data: string): void {
        this.service.write(this.id, data);
    }

    /** Ends the program and closes its tab. */
    kill(): Promise<void> {
        for (const stop of this.stops) stop();
        return this.service.kill(this.id);
    }
}

/** Shells by the name of their executable: their terminals are closed when they end cleanly. */
function isShell(info: TerminalInfo): boolean {
    return /^(?:bash|zsh|fish|sh|dash|ksh|tcsh|csh|nu|elvish|xonsh|pwsh|powershell|cmd)(?:\.exe)?$/i.test(basename(info.shell));
}

/**
 * A terminal's environment: the app's without Electron's own variables, then each layer (`null` removes a variable),
 * then what tells programs which terminal they run in.
 */
export function terminalEnv(base: NodeJS.ProcessEnv, layers: (Record<string, string | null> | undefined)[], version?: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(base)) {
        if (value === undefined || /^(?:ELECTRON_|CHROME_|GOOGLE_API_KEY$|ORIGINAL_XDG_CURRENT_DESKTOP$)/.test(key)) continue;
        env[key] = value;
    }
    for (const layer of layers) {
        for (const [key, value] of Object.entries(layer ?? {})) {
            if (value === null) delete env[key];
            else env[key] = value;
        }
    }
    env.TERM_PROGRAM = 'Appling';
    if (version) env.TERM_PROGRAM_VERSION = version;
    else delete env.TERM_PROGRAM_VERSION;
    env.COLORTERM = 'truecolor';
    return env;
}

function safeJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

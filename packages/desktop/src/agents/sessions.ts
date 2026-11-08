import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentSession, Claims, MemorySessionStore, SessionStatus } from '@appling/ai';
import { isRemoteId, repoId } from '../remote/location.js';
import type { TerminalService } from '../terminal/service.js';
import type { Notification } from '../terminal/shell-integration.js';
import { railSessions, sessionTitle, type RailSession, type SessionView } from './board.js';
import { Gateway } from './gateway.js';
import { answerKeys, launch, type AgentPreset, type Answer, type AnswerKeys, type Wiring } from './presets.js';
import { answers, hookSignal, notificationSignal, reduce, STATUS_COLORS, waiting, type AgentStatus, type Signal, type StatusState } from './status.js';

/** The hook client for command hooks, next to this module (`out/agents/hook.cjs`, also in the packaged app). */
export const HOOK_SCRIPT = (() => {
    const folder = dirname(fileURLToPath(import.meta.url));
    return basename(folder) === 'agents' ? join(folder, 'hook.cjs') : join(folder, 'agents', 'hook.cjs');
})();

/** An agent session as Desktop keeps it: the MCP session (#16) plus its terminal, preset and status. */
export interface AgentRecord extends SessionView {
    terminal: string;
    /** The MCP session's bearer token, to take the session back after a restart. */
    token: string;
    preset: string;
    wiring: Wiring;
    answers: AnswerKeys;
    claims: Claims;
    exit?: { code: number, signal?: number };
}

export interface AgentSessionsOptions {
    store: MemorySessionStore;
    terminals: TerminalService;
    /** Where the sessions (`sessions.json`) and each session's folder are kept. */
    folder: string;
    /** The MCP endpoint of the repo's IDE server; undefined while it is not running. */
    ideMcp(repo: string): string | undefined;
    presets(): AgentPreset[];
    hookScript?: string;
    /** Gemini CLI's system settings of this machine, merged under a session's own. */
    geminiSystemSettings?(): Record<string, unknown> | undefined;
}

type Events = {
    /** A session was started, changed or ended. */
    changed: [];
    /** A session started waiting for the user. */
    waiting: [record: AgentRecord];
};

interface SavedSessions {
    port?: number;
    sessions: AgentRecord[];
}

/**
 * The agent sessions of every repo (#10), in the main process: each one an MCP session of the shared store and a
 * terminal running its preset's agent, wired to the repo's MCP server through the gateway. Keeps their status from
 * MCP, hooks, terminal notifications and the exit; answers prompts by writing to the terminal; ends the MCP session
 * (and with it the claims) when the agent exits or its tab closes. Sessions are saved with their tokens, so after
 * a restart the agents that kept running in the pty host keep their MCP session. Electron free, tested with a
 * real pty host.
 */
export class AgentSessions extends EventEmitter<Events> {
    readonly gateway: Gateway;
    private readonly records = new Map<string, AgentRecord>();
    private readonly stops: (() => void)[] = [];
    private readonly file: string;

    constructor(private readonly options: AgentSessionsOptions) {
        super();
        this.file = join(options.folder, 'sessions.json');
        this.gateway = new Gateway({
            authenticate: token => options.store.authenticate(token),
            target: session => {
                const record = this.records.get(session);
                return record ? options.ideMcp(record.repo) : undefined;
            },
            onHook: (session, event, body) => {
                const record = this.records.get(session);
                const signal = record && hookSignal(record.wiring, event, body);
                if (record && signal) this.signal(record, signal);
            }
        });
    }

    /** Listens on the gateway (on its last port) and takes back the saved sessions whose terminals are still there. */
    async start(): Promise<void> {
        const saved = this.read();
        const port = await this.gateway.listen(saved.port ?? 0);
        const { store, terminals } = this.options;
        for (const record of saved.sessions) {
            if (!terminals.registry.repoOf(record.terminal)) {
                this.cleanup(record);
                continue;
            }
            this.records.set(record.id, record);
            if (record.status === 'exited') continue;
            store.adopt(this.sessionOf(record), record.token);
            // the agent was started with the old port: its files get the new one, which it reads when it starts again
            if (saved.port !== port) this.writeFiles(record);
        }
        const on = <E extends 'notification' | 'exit' | 'input' | 'changed'>(event: E, listener: (...args: never[]) => void) => {
            terminals.on(event, listener as never);
            this.stops.push(() => terminals.off(event, listener as never));
        };
        on('notification', (id: string, notification: Notification) => {
            const record = this.byTerminal(id);
            const signal = record && notificationSignal(record.wiring, notification);
            if (record && signal) this.signal(record, signal);
        });
        on('exit', (id: string, exit: { code: number, signal?: number }) => {
            const record = this.byTerminal(id);
            if (record) this.exited(record, exit);
        });
        on('input', (id: string, data: string) => {
            const record = this.byTerminal(id);
            if (record && answers(record, data)) this.signal(record, { type: 'answered' });
        });
        on('changed', (repo: string) => this.reconcile(repo));
        this.stops.push(store.onChange(sessions => this.mirror(sessions)));
        this.save();
        this.emit('changed');
    }

    /** Every session, the ones of closed repos too. */
    list(): AgentRecord[] {
        return [...this.records.values()];
    }

    get(id: string): AgentRecord | undefined {
        return this.records.get(id);
    }

    byTerminal(terminal: string): AgentRecord | undefined {
        return this.list().find(r => r.terminal === terminal);
    }

    /** The session whose tab the repo's terminal panel shows. */
    active(repo: string): AgentRecord | undefined {
        const entry = this.options.terminals.registry.get(repo);
        const tab = entry.tabs.find(t => t.id === entry.active);
        return tab ? this.byTerminal(tab.active) : undefined;
    }

    /** The repo's sessions for the rail, the shown one marked. */
    rail(repo: string): RailSession[] {
        return railSessions(this.list(), repo, this.active(repo)?.id);
    }

    /** Starts a preset's agent in a new tab of the repo's terminal panel, with its own MCP session. */
    async create(repo: string, presetName: string, options: { workspace?: string, cols?: number, rows?: number } = {}): Promise<AgentRecord> {
        const preset = this.options.presets().find(p => p.name === presetName);
        if (!preset) throw new Error(`There is no agent preset "${presetName}".`);
        // a remote repo's agent runs on that machine, which cannot reach this app's gateway (it needs a reverse forward)
        if (isRemoteId(repo)) throw new Error('Agent sessions do not run in remote repos yet: the agent there cannot reach the app\'s MCP gateway.');
        if (!this.options.ideMcp(repo)) throw new Error('The repo\'s IDE server is not running yet; start the session once it is.');
        const { session, token } = await this.options.store.open({ name: preset.name, repo, workspace: options.workspace });
        const record: AgentRecord = {
            id: session.id, terminal: '', token, preset: preset.name, wiring: preset.wiring, answers: preset.answers,
            name: preset.name, status: 'working', color: session.color,
            // the Desktop repo id (the rail's key), which for a local repo is the folder the MCP session works in
            repo: repoId(repo),
            ...options.workspace ? { workspace: options.workspace } : {}, started: session.started, claims: session.claims
        };
        try {
            const started = this.writeFiles(record, preset);
            const terminal = await this.options.terminals.createSession(repo, {
                name: preset.name, command: started.command, args: started.args, env: started.env, cols: options.cols, rows: options.rows,
                // what the pty host's tray and notifications show while the app is closed (#18)
                meta: { kind: 'agent', preset: preset.name, session: session.id, label: preset.name }
            });
            record.terminal = terminal.id;
            this.records.set(record.id, record);
            // what arrived between the spawn and now
            const early: Signal[] = terminal.notifications.map(n => notificationSignal(record.wiring, n)).filter(s => s !== undefined);
            for (const signal of early) this.signal(record, signal);
            if (terminal.exit) this.exited(record, terminal.exit);
        } catch (error) {
            await this.options.store.end(session.id);
            this.cleanup(record);
            throw error;
        }
        this.save();
        this.emit('changed');
        return record;
    }

    /** Answers the session's prompt by writing the preset's keys to its terminal; it then works again. */
    answer(id: string, answer: Answer): boolean {
        const record = this.records.get(id);
        if (!record || record.status === 'exited') return false;
        this.options.terminals.write(record.terminal, answerKeys(record.answers, answer));
        this.signal(record, { type: 'answered' });
        return true;
    }

    /** The user names the session: its label, as if the agent had set it. */
    async rename(id: string, label: string): Promise<void> {
        const record = this.records.get(id);
        if (!record) return;
        if (record.status === 'exited' || !await this.options.store.get(id)) {
            record.label = label.trim() || undefined;
            this.changed();
        } else await this.options.store.update(id, { label });
    }

    /** Ends the session: its terminal, its MCP session and claims, its files. */
    async close(id: string): Promise<void> {
        const record = this.records.get(id);
        if (!record) return;
        this.records.delete(id);
        await this.options.store.end(id).catch(() => undefined);
        this.cleanup(record);
        this.changed();
        await this.options.terminals.kill(record.terminal);
    }

    /** What the repo's terminal panel shows of its agent tabs, by terminal id. */
    tabs(repo: string): Record<string, { session: string, title: string, status: AgentStatus, statusColor: string, color: string, note?: string }> {
        return Object.fromEntries(this.list().filter(r => r.repo === repo).map(r => [r.terminal, {
            session: r.id, title: sessionTitle(r), status: r.status, statusColor: STATUS_COLORS[r.status], color: r.color, ...r.note ? { note: r.note } : {}
        }]));
    }

    /** Stops listening and closes the gateway; the agents keep running in the pty host. */
    dispose(): void {
        for (const stop of this.stops.splice(0)) stop();
        this.gateway.close();
    }

    /** Applies a signal; a change of status goes to the MCP session, so its peers and the IDE see it too. */
    private signal(record: AgentRecord, signal: Signal): void {
        if (signal.type === 'exit') return this.exited(record, signal);
        const before: StatusState = { status: record.status, note: record.note, prompt: record.prompt };
        const next = reduce(before, signal);
        if (next === before) return;
        this.apply(record, next);
        if (next.status !== 'exited' && (next.status !== before.status || next.note !== before.note)) {
            void this.options.store.update(record.id, { status: next.status as SessionStatus, note: next.note ?? '' }).catch(() => undefined);
        }
    }

    private apply(record: AgentRecord, next: StatusState): void {
        const was = record.status;
        record.status = next.status;
        if (next.note) record.note = next.note;
        else delete record.note;
        if (next.prompt) record.prompt = next.prompt;
        else delete record.prompt;
        this.changed();
        if (waiting(next.status) && !waiting(was)) this.emit('waiting', record);
    }

    /** The agent ended: the tab stays gray with its scrollback; the MCP session and its claims end. */
    private exited(record: AgentRecord, exit: { code: number, signal?: number }): void {
        if (record.status === 'exited') return;
        record.exit = exit;
        record.ended = new Date().toISOString();
        this.apply(record, reduce({ status: record.status }, { type: 'exit', ...exit }));
        void this.options.store.end(record.id).catch(() => undefined);
        // the token and the configuration files go with the agent
        rmSync(this.dirOf(record), { recursive: true, force: true });
    }

    /** The repo's terminals changed: a closed tab ends its session, an ended terminal (seen after a restart) exits it. */
    private reconcile(repo: string): void {
        const { terminals } = this.options;
        for (const record of this.list().filter(r => r.repo === repo || !terminals.registry.repoOf(r.terminal))) {
            if (!terminals.registry.repoOf(record.terminal)) {
                void this.close(record.id);
                continue;
            }
            const exit = terminals.state(record.terminal)?.exit;
            if (exit) this.exited(record, exit);
        }
        this.emit('changed');
    }

    /** Label, status, note, colour and claims from the MCP sessions (the agent's own reports). */
    private mirror(sessions: AgentSession[]): void {
        let changed = false;
        for (const session of sessions) {
            const record = this.records.get(session.id);
            if (!record || record.status === 'exited') continue;
            const was = record.status;
            const before = JSON.stringify([record.label, record.status, record.note, record.claims]);
            record.label = session.label;
            if (!record.label) delete record.label;
            record.status = session.status;
            if (session.note) record.note = session.note;
            else delete record.note;
            if (!waiting(session.status)) delete record.prompt;
            record.claims = session.claims;
            if (JSON.stringify([record.label, record.status, record.note, record.claims]) === before) continue;
            changed = true;
            if (waiting(record.status) && !waiting(was)) this.emit('waiting', record);
        }
        if (changed) this.changed();
    }

    private changed(): void {
        this.save();
        this.emit('changed');
        this.syncLabels();
    }

    private readonly labels = new Map<string, string>();

    /** Hands the pty host the sessions' titles, for its tray and notifications while the app is closed. */
    private syncLabels(): void {
        for (const record of this.records.values()) {
            const title = sessionTitle(record);
            if (!record.terminal || this.labels.get(record.terminal) === title) continue;
            this.labels.set(record.terminal, title);
            void this.options.terminals.connection().then(client => client.update(record.terminal, { meta: { label: title }, title })).catch(() => undefined);
        }
    }

    private sessionOf(record: AgentRecord): AgentSession {
        return {
            id: record.id, name: record.name, ...record.label ? { label: record.label } : {}, status: record.status as SessionStatus,
            ...record.note ? { note: record.note } : {}, color: record.color, repo: record.repo,
            ...record.workspace ? { workspace: record.workspace } : {}, claims: record.claims, started: record.started, unread: 0
        };
    }

    private dirOf(record: AgentRecord): string {
        return join(this.options.folder, 'sessions', record.id);
    }

    /** Writes the session's configuration files (mode 0600 in a 0700 folder) and returns how to start its agent. */
    private writeFiles(record: AgentRecord, preset?: AgentPreset): ReturnType<typeof launch> {
        preset ??= this.options.presets().find(p => p.name === record.preset) ?? { name: record.preset, command: '', args: [], env: {}, wiring: record.wiring, answers: record.answers, builtin: false };
        const dir = this.dirOf(record);
        const started = launch(preset, {
            session: record.id, mcpUrl: this.gateway.mcpUrl, hookUrl: this.gateway.hookUrl, token: record.token, dir,
            hookScript: this.options.hookScript ?? HOOK_SCRIPT,
            ...preset.wiring === 'gemini' ? { geminiSystemSettings: this.options.geminiSystemSettings?.() } : {}
        });
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        for (const [path, content] of Object.entries(started.files)) {
            mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
            writeFileSync(path, content, { mode: 0o600 });
        }
        return started;
    }

    private cleanup(record: AgentRecord): void {
        rmSync(this.dirOf(record), { recursive: true, force: true });
    }

    private read(): SavedSessions {
        try {
            const data = JSON.parse(readFileSync(this.file, 'utf8')) as SavedSessions;
            const sessions = Array.isArray(data.sessions) ? data.sessions.filter(r => r && typeof r.id === 'string' && typeof r.terminal === 'string' && typeof r.token === 'string') : [];
            return { ...Number.isInteger(data.port) ? { port: data.port } : {}, sessions };
        } catch {
            return { sessions: [] };
        }
    }

    private save(): void {
        try {
            mkdirSync(this.options.folder, { recursive: true, mode: 0o700 });
            const data: SavedSessions = { port: this.gateway.port, sessions: this.list() };
            writeFileSync(this.file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
            if (existsSync(this.file)) chmodSync(this.file, 0o600);
        } catch {
            // the sessions are then not taken back after a restart; their terminals still are
        }
    }
}

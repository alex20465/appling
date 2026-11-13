import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sessionTitle, type AgentSession, type MemorySessionStore, type SessionStatus } from '@appling/ai';
import {
    answerKeys, attach, Gateway, hookSignal, launch, notificationSignal, reduce, waiting,
    type AgentPreset, type AgentStatus, type Answer, type Signal, type StatusState, type TerminalNotification
} from '@appling/ai/agents';

/**
 * Agent sessions in VS Code terminals (#10): each one an MCP session of the
 * shared store and a terminal running a preset's agent, wired to its project's inspect server through the gateway. The
 * status comes from MCP, the agent's hooks, its terminal notifications (OSC 9, OSC 777) and its exit. VS Code free:
 * the terminals are injected (`agent-terminals.ts` in the extension, fakes in the tests).
 */

/** How to start an agent in a terminal, and what the terminal reports back. */
export interface TerminalSpec {
    name: string;
    cwd: string;
    command: string;
    args: string[];
    env: Record<string, string>;
    /** The session's colour. */
    color: string;
}

export interface TerminalEvents {
    /** Notifications the agent wrote to its terminal. */
    notification(notification: TerminalNotification): void;
    /** The agent ended with its exit code (its terminal stays), or its terminal was closed (`code` undefined). */
    exit(code: number | undefined): void;
}

export interface AgentTerminal {
    write(data: string): void;
    show(): void;
    /** Whether the terminal is the one the user sees now. */
    visible(): boolean;
    dispose(): void;
}

export type AgentTerminals = (spec: TerminalSpec, events: TerminalEvents) => AgentTerminal;

export interface AgentRecord extends StatusState {
    id: string;
    name: string;
    label?: string;
    color: string;
    /** The project folder the session works in. */
    repo: string;
    preset: AgentPreset;
    started: string;
    /** For an agent the user started: the folder it runs in and the arguments that take the MCP server out of its configuration. */
    attached?: { cwd: string, remove: string[] };
}

export interface AgentsOptions {
    store: MemorySessionStore;
    terminals: AgentTerminals;
    /** Where each session's configuration files go, one folder per session. */
    folder: string;
    /** The MCP endpoint of the project's inspect server; undefined while it is not running. */
    ideMcp(repo: string): string | undefined;
    hookScript: string;
    /** The workspace the sessions belong to. */
    workspace?: string;
    /** Runs an agent's own command to completion, to add the MCP server to an agent the user started. */
    run?(command: string, args: string[], cwd: string): Promise<unknown>;
    geminiSystemSettings?(): Record<string, unknown> | undefined;
}

type Events = {
    changed: [];
    /** A session started waiting for the user. */
    waiting: [record: AgentRecord];
};

export class Agents extends EventEmitter<Events> {
    readonly gateway: Gateway;
    private readonly records = new Map<string, AgentRecord>();
    private readonly terminals = new Map<string, AgentTerminal>();
    private stop?: () => void;

    constructor(private readonly options: AgentsOptions) {
        super();
        this.gateway = new Gateway({
            authenticate: token => options.store.authenticate(token),
            target: session => {
                const record = this.records.get(session);
                return record ? options.ideMcp(record.repo) : undefined;
            },
            onHook: (session, event, body) => {
                const record = this.records.get(session);
                const signal = record && hookSignal(record.preset.wiring, event, body);
                if (record && signal) this.signal(record, signal);
            }
        });
    }

    async start(): Promise<void> {
        await this.gateway.listen();
        this.stop = this.options.store.onChange(sessions => this.mirror(sessions));
    }

    list(): AgentRecord[] {
        return [...this.records.values()];
    }

    get(id: string): AgentRecord | undefined {
        return this.records.get(id);
    }

    /** Starts a preset's agent in a new terminal of the project, with its own MCP session. */
    async create(repo: string, preset: AgentPreset): Promise<AgentRecord> {
        if (!this.options.ideMcp(repo)) throw new Error('The project\'s inspect server is not running yet; start the session once it is.');
        const { session, token } = await this.options.store.open({ name: preset.name, repo, workspace: this.options.workspace });
        const record: AgentRecord = { id: session.id, name: preset.name, color: session.color, repo, preset, status: 'working', started: session.started };
        const dir = join(this.options.folder, session.id);
        try {
            const started = launch(preset, {
                session: session.id, mcpUrl: this.gateway.mcpUrl, hookUrl: this.gateway.hookUrl, token, dir, hookScript: this.options.hookScript,
                ...preset.wiring === 'gemini' ? { geminiSystemSettings: this.options.geminiSystemSettings?.() } : {}
            });
            mkdirSync(dir, { recursive: true, mode: 0o700 });
            for (const [path, content] of Object.entries(started.files)) {
                mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
                writeFileSync(path, content, { mode: 0o600 });
            }
            this.records.set(record.id, record);
            const terminal = this.options.terminals({ name: preset.name, cwd: repo, command: started.command, args: started.args, env: started.env, color: session.color }, {
                notification: notification => {
                    const signal = notificationSignal(preset.wiring, notification);
                    if (signal) this.signal(record, signal);
                },
                exit: code => code === undefined ? void this.close(record.id) : this.signal(record, { type: 'exit', code })
            });
            this.terminals.set(record.id, terminal);
        } catch (error) {
            this.records.delete(record.id);
            await this.options.store.end(session.id);
            rmSync(dir, { recursive: true, force: true });
            throw error;
        }
        this.emit('changed');
        return record;
    }

    /** Whether the preset's agent can take the MCP server while it runs in a terminal of the user's. */
    attachable(preset: AgentPreset): boolean {
        return !!this.options.run && !!attach(preset, { mcpUrl: '', token: '' });
    }

    /**
     * Gives an agent the user started in `terminal`, in the folder `cwd` of the project, an MCP session of its own:
     * the agent's own command adds the server to its local configuration of that folder, and the session's end
     * removes it. The terminal stays the user's.
     */
    async adopt(repo: string, cwd: string, preset: AgentPreset, terminal: AgentTerminal): Promise<AgentRecord> {
        if (!this.options.ideMcp(repo)) throw new Error('The project\'s inspect server is not running yet.');
        const { session, token } = await this.options.store.open({ name: preset.name, repo, workspace: this.options.workspace });
        const commands = attach(preset, { mcpUrl: this.gateway.mcpUrl, token })!;
        const record: AgentRecord = { id: session.id, name: preset.name, color: session.color, repo, preset, status: 'working', started: session.started, attached: { cwd, remove: commands.remove } };
        try {
            // an entry a window left behind would make the add fail
            await this.options.run!(preset.command, commands.remove, cwd).catch(() => undefined);
            await this.options.run!(preset.command, commands.add, cwd);
        } catch (error) {
            await this.options.store.end(session.id);
            throw error;
        }
        this.records.set(record.id, record);
        this.terminals.set(record.id, terminal);
        this.emit('changed');
        return record;
    }

    /** Shows the session's terminal; false when there is none. */
    focus(id: string): boolean {
        const terminal = this.terminals.get(id);
        terminal?.show();
        return !!terminal;
    }

    /** Whether the session's terminal is the one the user sees now. */
    visible(id: string): boolean {
        return this.terminals.get(id)?.visible() ?? false;
    }

    /** Answers the session's prompt by writing the preset's keys to its terminal; it then works again. */
    answer(id: string, answer: Answer): boolean {
        const record = this.records.get(id);
        const terminal = this.terminals.get(id);
        if (!record || !terminal || record.status === 'exited') return false;
        terminal.write(answerKeys(record.preset.answers, answer));
        this.signal(record, { type: 'answered' });
        return true;
    }

    /** Ends the session: its terminal, its MCP session and claims, its files. */
    async close(id: string): Promise<void> {
        const record = this.records.get(id);
        if (!record) return;
        this.records.delete(id);
        const terminal = this.terminals.get(id);
        this.terminals.delete(id);
        if (record.attached) await this.options.run!(record.preset.command, record.attached.remove, record.attached.cwd).catch(() => undefined);
        else terminal?.dispose();
        await this.options.store.end(id).catch(() => undefined);
        rmSync(join(this.options.folder, id), { recursive: true, force: true });
        this.emit('changed');
    }

    async dispose(): Promise<void> {
        this.stop?.();
        await Promise.all(this.list().map(r => this.close(r.id)));
        this.gateway.close();
    }

    title(record: AgentRecord): string {
        return sessionTitle(record);
    }

    /** Applies a signal; a change of status goes to the MCP session, so its peers and the inspector see it too. */
    private signal(record: AgentRecord, signal: Signal): void {
        const was = record.status;
        const next = reduce(record, signal);
        if (next === record) return;
        record.status = next.status;
        record.note = next.note;
        record.prompt = next.prompt;
        if (next.status === 'exited') {
            // the MCP session and its claims end with the agent; the terminal stays with its output
            void this.options.store.end(record.id).catch(() => undefined);
            rmSync(join(this.options.folder, record.id), { recursive: true, force: true });
        } else if (next.status !== was || next.note) {
            void this.options.store.update(record.id, { status: next.status as SessionStatus, note: next.note ?? '' }).catch(() => undefined);
        }
        this.emit('changed');
        if (waiting(next.status) && !waiting(was)) this.emit('waiting', record);
    }

    /** Label, status and note from the MCP sessions (the agent's own reports). */
    private mirror(sessions: AgentSession[]): void {
        let changed = false;
        for (const session of sessions) {
            const record = this.records.get(session.id);
            if (!record || record.status === 'exited') continue;
            const before = JSON.stringify([record.label, record.status, record.note]);
            const was: AgentStatus = record.status;
            record.label = session.label;
            record.status = session.status;
            record.note = session.note;
            if (!waiting(session.status)) delete record.prompt;
            if (JSON.stringify([record.label, record.status, record.note]) === before) continue;
            changed = true;
            if (waiting(record.status) && !waiting(was)) this.emit('waiting', record);
        }
        if (changed) this.emit('changed');
    }
}

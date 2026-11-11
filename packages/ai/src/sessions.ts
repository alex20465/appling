import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { isAbsolute, posix, resolve } from 'node:path';

/**
 * Agent sessions: the terminals in which coding agents work on a repo. Each one has an identity that its MCP
 * connection carries (a bearer token), a label and a status it keeps current, and the elements and files it claims.
 * The store is shared by the IDE servers of a workspace's repos: Appling Desktop holds one `MemorySessionStore` in its
 * main process and serves it to every IDE server child over IPC (`serveSessionStore`, `RemoteSessionStore`); a lone
 * IDE server keeps its own.
 */

export const SESSION_STATUSES = ['working', 'blocked', 'needs-input', 'done', 'failed'] as const;
export type SessionStatus = typeof SESSION_STATUSES[number];

/** Session colours, assigned in turn: the tab and the claimed elements on the canvas use them. */
export const SESSION_COLORS = ['#2f9e44', '#1971c2', '#e8590c', '#9c36b5', '#0c8599', '#c2255c', '#5c940d', '#f08c00'];

export interface Claims {
    /** Qualified names of model elements; a claim covers the element's members. */
    elements: string[];
    /** Absolute paths. */
    files: string[];
}

export interface AgentSession {
    id: string;
    /** The agent's name, such as Claude Code: what the tab shows until the agent sets a label. */
    name: string;
    /** What the session is about, set by the agent after reading the first prompt or by the user. */
    label?: string;
    status: SessionStatus;
    /** Why the session is blocked, needs input or failed, or what it finished. */
    note?: string;
    color: string;
    /** The repo folder the session works in. */
    repo: string;
    /** The workspace it belongs to; sessions see the other sessions of their workspace (or, without one, of their repo). */
    workspace?: string;
    claims: Claims;
    started: string;
    /** The last tool call, so every call is attributed to its session. */
    active?: { tool: string, at: string };
    unread: number;
}

export interface SessionMessage {
    /** The sending session's id, or `user` for the user. */
    from: string;
    fromLabel: string;
    to: string;
    text: string;
    at: string;
}

/** A claim of another session that an edit or a claim touches. */
export interface ClaimConflict {
    session: string;
    label: string;
    /** The element or file of the other session's claim. */
    claimed: string;
    /** What touches it. */
    touched: string;
}

export interface OpenSession {
    name?: string;
    repo: string;
    workspace?: string;
    label?: string;
}

/** Where sessions live. Every method is async so a store can live in another process. */
export interface SessionStore {
    /** Starts a session; the token is handed to the agent's MCP client as its bearer token. */
    open(input: OpenSession): Promise<{ session: AgentSession, token: string }>;
    /** The session a bearer token belongs to. */
    authenticate(token: string): Promise<string | undefined>;
    /** Ends a session; its claims end with it. */
    end(id: string): Promise<void>;
    get(id: string): Promise<AgentSession | undefined>;
    list(): Promise<AgentSession[]>;
    update(id: string, change: { label?: string, status?: SessionStatus, note?: string }): Promise<AgentSession>;
    claim(id: string, claims: Partial<Claims>): Promise<AgentSession>;
    /** Without claims: releases all of them. */
    release(id: string, claims?: Partial<Claims>): Promise<AgentSession>;
    /** Records a tool call of the session. */
    touch(id: string, tool: string): Promise<void>;
    /** Sends a message to a session, named by its id or its label. Returns the recipient's id. */
    send(from: string, to: string, text: string): Promise<string>;
    /** Delivers a message from the user or the app (not a session) to a session's inbox, such as a question typed in its view. */
    post(to: string, message: { fromLabel: string, text: string }): Promise<void>;
    /** The session's unread messages; reading them marks them read. */
    inbox(id: string): Promise<SessionMessage[]>;
    /** Calls back with every session after each change. */
    onChange(listener: (sessions: AgentSession[]) => void): () => void;
}

/** The display name of a session: its label, else its agent's name. */
export function sessionTitle(session: Pick<AgentSession, 'label' | 'name'>): string {
    return session.label ?? session.name;
}

/** Whether two element claims overlap: one is the other or contains it. */
export function overlaps(a: string, b: string): boolean {
    return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}

/** The sessions a session coordinates with: those of its workspace, or of its repo when it has none. */
export function peers(sessions: AgentSession[], self: AgentSession): AgentSession[] {
    return sessions.filter(s => s.id !== self.id && (self.workspace ? s.workspace === self.workspace : s.repo === self.repo));
}

/** The claims of other sessions that the given elements (in the session's repo) and files touch. */
export function findConflicts(sessions: AgentSession[], self: AgentSession, touched: Partial<Claims>): ClaimConflict[] {
    const conflicts: ClaimConflict[] = [];
    for (const other of peers(sessions, self)) {
        const label = sessionTitle(other);
        if (other.repo === self.repo) {
            for (const element of touched.elements ?? []) {
                for (const claimed of other.claims.elements) if (overlaps(element, claimed)) conflicts.push({ session: other.id, label, claimed, touched: element });
            }
        }
        for (const file of touched.files ?? []) {
            const path = absolute(self.repo, file);
            for (const claimed of other.claims.files) if (claimed === path) conflicts.push({ session: other.id, label, claimed, touched: path });
        }
    }
    return conflicts;
}

/** A repo id such as `ssh://host/srv/shop`: a remote repo that Appling Desktop names by its location. */
const LOCATION = /^[a-z][a-z\d+.-]*:\/\//i;

/**
 * A repo folder as sessions keep it. A local folder is resolved; a remote one is kept as it is on its machine: a
 * location id (`ssh://...`) unchanged, a POSIX folder (`/srv/shop`, the folder an IDE server there serves) with POSIX
 * rules, so a Windows Desktop never turns it into `C:\srv\shop`.
 */
export function repoFolder(repo: string): string {
    if (LOCATION.test(repo)) return repo;
    return repo.startsWith('/') ? posix.resolve(repo) : resolve(repo);
}

/** A file of a repo as an absolute path, by the rules of the repo's machine (see `repoFolder`). */
export function absolute(repo: string, file: string): string {
    if (LOCATION.test(repo)) return LOCATION.test(file) || file.startsWith('/') ? file : `${repo.replace(/\/+$/, '')}/${file.replaceAll('\\', '/')}`;
    if (repo.startsWith('/')) return posix.resolve(repo, file.replaceAll('\\', '/'));
    return isAbsolute(file) ? resolve(file) : resolve(repo, file);
}

/** Sessions in memory, for one process: the IDE server on its own, or Appling Desktop's main process. */
export class MemorySessionStore implements SessionStore {

    private sessions = new Map<string, AgentSession>();
    private tokens = new Map<string, string>();
    private messages = new Map<string, SessionMessage[]>();
    private listeners = new Set<(sessions: AgentSession[]) => void>();
    private opened = 0;

    async open(input: OpenSession): Promise<{ session: AgentSession, token: string }> {
        const session: AgentSession = {
            id: randomUUID(), name: input.name ?? 'Agent', label: input.label, status: 'working',
            color: SESSION_COLORS[this.opened++ % SESSION_COLORS.length], repo: repoFolder(input.repo), workspace: input.workspace,
            claims: { elements: [], files: [] }, started: new Date().toISOString(), unread: 0
        };
        const token = randomBytes(24).toString('base64url');
        this.sessions.set(session.id, session);
        this.tokens.set(token, session.id);
        this.messages.set(session.id, []);
        this.changed();
        return { session: structuredClone(session), token };
    }

    /**
     * Takes back a session with the token it was handed before, such as one whose agent kept running in a terminal
     * while Appling Desktop restarted: its agent goes on with the same bearer token. Its claims are taken as saved.
     */
    adopt(session: AgentSession, token: string): AgentSession {
        const adopted: AgentSession = { ...structuredClone(session), repo: repoFolder(session.repo), unread: 0 };
        this.sessions.set(adopted.id, adopted);
        for (const [known, owner] of this.tokens) if (owner === adopted.id) this.tokens.delete(known);
        this.tokens.set(token, adopted.id);
        this.messages.set(adopted.id, []);
        this.opened++;
        this.changed();
        return structuredClone(adopted);
    }

    async authenticate(token: string): Promise<string | undefined> {
        const given = Buffer.from(token);
        for (const [known, id] of this.tokens) {
            const candidate = Buffer.from(known);
            if (candidate.length === given.length && timingSafeEqual(candidate, given)) return id;
        }
        return undefined;
    }

    async end(id: string): Promise<void> {
        if (!this.sessions.delete(id)) return;
        this.messages.delete(id);
        for (const [token, owner] of this.tokens) if (owner === id) this.tokens.delete(token);
        this.changed();
    }

    async get(id: string): Promise<AgentSession | undefined> {
        const session = this.sessions.get(id);
        return session && structuredClone(session);
    }

    async list(): Promise<AgentSession[]> {
        return structuredClone([...this.sessions.values()]);
    }

    async update(id: string, change: { label?: string, status?: SessionStatus, note?: string }): Promise<AgentSession> {
        const session = this.session(id);
        if (change.status !== undefined && !SESSION_STATUSES.includes(change.status)) throw new Error(`Unknown status ${change.status}; one of ${SESSION_STATUSES.join(', ')}.`);
        if (change.label !== undefined) session.label = change.label.trim() || undefined;
        if (change.status !== undefined) {
            session.status = change.status;
            session.note = change.note?.trim() || undefined;
        } else if (change.note !== undefined) session.note = change.note.trim() || undefined;
        this.changed();
        return structuredClone(session);
    }

    async claim(id: string, claims: Partial<Claims>): Promise<AgentSession> {
        const session = this.session(id);
        session.claims.elements = [...new Set([...session.claims.elements, ...claims.elements ?? []])];
        session.claims.files = [...new Set([...session.claims.files, ...(claims.files ?? []).map(f => absolute(session.repo, f))])];
        this.changed();
        return structuredClone(session);
    }

    async release(id: string, claims?: Partial<Claims>): Promise<AgentSession> {
        const session = this.session(id);
        if (!claims) session.claims = { elements: [], files: [] };
        else {
            const files = new Set((claims.files ?? []).map(f => absolute(session.repo, f)));
            session.claims.elements = session.claims.elements.filter(e => !claims.elements?.includes(e));
            session.claims.files = session.claims.files.filter(f => !files.has(f));
        }
        this.changed();
        return structuredClone(session);
    }

    async touch(id: string, tool: string): Promise<void> {
        this.session(id).active = { tool, at: new Date().toISOString() };
        this.changed();
    }

    async send(from: string, to: string, text: string): Promise<string> {
        const sender = this.session(from);
        const candidates = peers([...this.sessions.values()], sender);
        const byId = candidates.find(s => s.id === to);
        const byTitle = candidates.filter(s => sessionTitle(s) === to);
        if (!byId && byTitle.length > 1) throw new Error(`More than one session is called ${to}; pass its id.`);
        const recipient = byId ?? byTitle[0];
        if (!recipient) throw new Error(`No other session ${to} in this workspace.`);
        this.messages.get(recipient.id)!.push({ from, fromLabel: sessionTitle(sender), to: recipient.id, text, at: new Date().toISOString() });
        recipient.unread++;
        this.changed();
        return recipient.id;
    }

    async post(to: string, message: { fromLabel: string, text: string }): Promise<void> {
        const recipient = this.session(to);
        this.messages.get(to)!.push({ from: 'user', fromLabel: message.fromLabel, to, text: message.text, at: new Date().toISOString() });
        recipient.unread++;
        this.changed();
    }

    async inbox(id: string): Promise<SessionMessage[]> {
        const session = this.session(id);
        const messages = this.messages.get(id)!.splice(0);
        if (session.unread) {
            session.unread = 0;
            this.changed();
        }
        return messages;
    }

    onChange(listener: (sessions: AgentSession[]) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private session(id: string): AgentSession {
        const session = this.sessions.get(id);
        if (!session) throw new Error(`No session ${id}; it has ended.`);
        return session;
    }

    private changed(): void {
        if (!this.listeners.size) return;
        const sessions = structuredClone([...this.sessions.values()]);
        this.listeners.forEach(listener => listener(sessions));
    }
}

/** A message channel between two processes, such as a child process's IPC channel. */
export interface Channel {
    send(message: unknown): void;
    onMessage(listener: (message: unknown) => void): () => void;
}

/** The IPC channel of a child process (from the parent) or of this process (from the child). */
export function ipcChannel(target: { connected?: boolean, send?(message: unknown): unknown, on(event: 'message', listener: (message: unknown) => void): unknown, off(event: 'message', listener: (message: unknown) => void): unknown }): Channel {
    return {
        send: message => {
            if (target.connected !== false) target.send?.(message);
        },
        onMessage: listener => {
            target.on('message', listener);
            return () => target.off('message', listener);
        }
    };
}

type StoreMethod = Exclude<keyof SessionStore, 'onChange'>;
const METHODS: StoreMethod[] = ['open', 'authenticate', 'end', 'get', 'list', 'update', 'claim', 'release', 'touch', 'send', 'post', 'inbox'];

interface Call { type: 'sessions:call', call: number, method: StoreMethod, args: unknown[] }
interface Result { type: 'sessions:result', call: number, result?: unknown, error?: string }
interface Change { type: 'sessions:change', sessions: AgentSession[] }

/** Serves a store to another process over a channel: its calls and every change. Returns the function that stops. */
export function serveSessionStore(store: SessionStore, channel: Channel): () => void {
    const stopChanges = store.onChange(sessions => channel.send({ type: 'sessions:change', sessions } satisfies Change));
    const stopCalls = channel.onMessage(async message => {
        const call = message as Call;
        if (call?.type !== 'sessions:call' || !METHODS.includes(call.method)) return;
        try {
            const result = await (store[call.method] as (...args: unknown[]) => Promise<unknown>)(...call.args);
            channel.send({ type: 'sessions:result', call: call.call, result } satisfies Result);
        } catch (error) {
            channel.send({ type: 'sessions:result', call: call.call, error: (error as Error).message } satisfies Result);
        }
    });
    return () => {
        stopChanges();
        stopCalls();
    };
}

/** A store that lives in another process, reached over a channel that `serveSessionStore` serves. */
export class RemoteSessionStore implements SessionStore {

    private calls = new Map<number, { done(value: unknown): void, fail(error: Error): void }>();
    private listeners = new Set<(sessions: AgentSession[]) => void>();
    private next = 0;

    constructor(private readonly channel: Channel, private readonly timeout = 10000) {
        channel.onMessage(message => {
            const reply = message as Result | Change;
            if (reply?.type === 'sessions:change') this.listeners.forEach(listener => listener(reply.sessions));
            if (reply?.type !== 'sessions:result') return;
            const pending = this.calls.get(reply.call);
            this.calls.delete(reply.call);
            if (reply.error !== undefined) pending?.fail(new Error(reply.error));
            else pending?.done(reply.result);
        });
    }

    open(input: OpenSession) { return this.call<{ session: AgentSession, token: string }>('open', input); }
    authenticate(token: string) { return this.call<string | undefined>('authenticate', token); }
    end(id: string) { return this.call<void>('end', id); }
    get(id: string) { return this.call<AgentSession | undefined>('get', id); }
    list() { return this.call<AgentSession[]>('list'); }
    update(id: string, change: { label?: string, status?: SessionStatus, note?: string }) { return this.call<AgentSession>('update', id, change); }
    claim(id: string, claims: Partial<Claims>) { return this.call<AgentSession>('claim', id, claims); }
    release(id: string, claims?: Partial<Claims>) { return this.call<AgentSession>('release', id, claims); }
    touch(id: string, tool: string) { return this.call<void>('touch', id, tool); }
    send(from: string, to: string, text: string) { return this.call<string>('send', from, to, text); }
    post(to: string, message: { fromLabel: string, text: string }) { return this.call<void>('post', to, message); }
    inbox(id: string) { return this.call<SessionMessage[]>('inbox', id); }

    onChange(listener: (sessions: AgentSession[]) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private call<T>(method: StoreMethod, ...args: unknown[]): Promise<T> {
        const call = this.next++;
        return new Promise<T>((done, fail) => {
            const timer = setTimeout(() => {
                this.calls.delete(call);
                fail(new Error(`The session store did not answer ${method} within ${this.timeout}ms.`));
            }, this.timeout);
            this.calls.set(call, {
                done: value => { clearTimeout(timer); done(value as T); },
                fail: error => { clearTimeout(timer); fail(error); }
            });
            this.channel.send({ type: 'sessions:call', call, method, args } satisfies Call);
        });
    }
}

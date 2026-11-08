import { z } from 'zod';
import type { EditOperation } from '@appling/model';
import { define, type Tools } from './tools.js';
import type { PlaybookStore } from './playbook.js';
import { findConflicts, peers, SESSION_STATUSES, sessionTitle, type AgentSession, type Channel, type ClaimConflict, type Claims, type SessionStore } from './sessions.js';

/** What the IDE shows, as far as the IDE server and the app around it know it. */
export interface IdeContext {
    /** The session's own tab. */
    tab?: { id: string, title: string, status: string, active: boolean };
    /** The repo of this IDE server, and the one the app shows. */
    repo: string;
    activeRepo?: string;
    workspace?: string;
    /** The tabs of the workspace: sessions, terminals, editors. */
    tabs?: { id: string, title: string, kind: string, repo?: string, active?: boolean }[];
    /** The canvas: lens, seed and unfolded elements, as the client reports it. */
    view?: Record<string, unknown>;
    /** The element selected on the canvas or in the editor. */
    selection?: string;
    /** The model file open in the editor. */
    file?: string;
}

export const IDE_ACTIONS = ['focus', 'open', 'highlight', 'reveal'] as const;

/** focus: show the session's tab. open: open an element or file. highlight: mark elements on the canvas. reveal: select an element and show it. */
export interface IdeAction {
    action: typeof IDE_ACTIONS[number];
    /** Qualified names of elements. */
    elements?: string[];
    file?: string;
    line?: number;
}

/**
 * The IDE around a session: the IDE server answers with what its client shows and passes actions to it; Appling
 * Desktop implements it to add its tabs and to focus them.
 */
export interface IdeHost {
    context(session: AgentSession): Promise<IdeContext>;
    act(session: AgentSession, action: IdeAction): Promise<{ ok: boolean, reason?: string }>;
}

/**
 * The part of a session's IDE that the app around the IDE server knows: Appling Desktop answers with the session's
 * tab, the active repo, the workspace and its tabs, and focuses tabs. Both methods are optional.
 */
export interface AppHost {
    context?(session: AgentSession): Promise<Partial<IdeContext>>;
    /** Returns whether it handled the action, such as focusing the session's tab. */
    act?(session: AgentSession, action: IdeAction): Promise<boolean>;
}

/** Serves an app host to an IDE server child over its IPC channel. */
export function serveAppHost(host: AppHost, channel: Channel): () => void {
    return channel.onMessage(async message => {
        const call = message as { type?: string, call: number, session: AgentSession, action?: IdeAction };
        if (call?.type !== 'host:context' && call?.type !== 'host:act') return;
        try {
            const result = call.type === 'host:context' ? await host.context?.(call.session) ?? {} : await host.act?.(call.session, call.action!) ?? false;
            channel.send({ type: 'host:result', call: call.call, result });
        } catch (error) {
            channel.send({ type: 'host:result', call: call.call, error: (error as Error).message });
        }
    });
}

/** The app host of the parent process, reached over IPC; it answers within the timeout or counts as absent. */
export function remoteAppHost(channel: Channel, timeout = 2000): AppHost {
    let next = 0;
    const pending = new Map<number, (result: unknown) => void>();
    channel.onMessage(message => {
        const reply = message as { type?: string, call: number, result?: unknown };
        if (reply?.type !== 'host:result') return;
        pending.get(reply.call)?.(reply.result);
        pending.delete(reply.call);
    });
    const call = <T>(type: string, fallback: T, payload: object) => new Promise<T>(done => {
        const id = next++;
        const timer = setTimeout(() => { pending.delete(id); done(fallback); }, timeout);
        pending.set(id, result => { clearTimeout(timer); done((result ?? fallback) as T); });
        channel.send({ type, call: id, ...payload });
    });
    return {
        context: session => call<Partial<IdeContext>>('host:context', {}, { session }),
        act: (session, action) => call<boolean>('host:act', false, { session, action })
    };
}

/** The session one MCP connection belongs to. */
export interface SessionScope {
    id: string;
    store: SessionStore;
    host?: IdeHost;
    /** The workspace playbooks; with them the session gets the playbook tools. */
    playbook?: PlaybookStore;
}

export const SESSION_INSTRUCTIONS = `You work in an agent session of Appling Desktop, next to other agent sessions that may change the same model and files at the same time. The session tools keep you coordinated with them and show the person what each session does:

- After reading the first prompt, set a short static label with session_set_label that names the topic of the work, such as "Invoice entity and its payment flow". Keep it until the topic changes.
- Keep the status current with session_set_status: working while you work, needs-input when you wait for the person, blocked when another session or something outside holds you up, done when the task is finished, failed when you gave up; add a note that says why.
- Before you change elements or files, call sessions_list to see what the other sessions claimed, and claim what you work on with session_claim: elements by qualified name (a claim covers the element's members) and files. Do not change what another session claimed; ask it with session_message instead, or wait. Release claims with session_release when you are done with them; they also end with the session.
- An edit that touches another session's claim still goes through but comes back with a warning: tell the session with session_message and settle it before you go on.
- When a tool result mentions unread messages, read them with session_inbox and answer them.
- ide_context tells what the IDE shows (your tab, the repo, the open tabs, the canvas view and the selection; read it when the person says "this" or "here"); ide_act focuses your tab, opens, highlights or reveals elements to show the person what you mean.`;

const claimsInput = {
    elements: z.array(z.string()).optional().describe('Qualified names of model elements, such as ["sales.Order", "sales.OrderFlow"]'),
    files: z.array(z.string()).optional().describe('File paths, absolute or relative to the repo')
};

function brief(session: AgentSession) {
    return { id: session.id, label: sessionTitle(session), name: session.name, status: session.status, note: session.note, repo: session.repo, claims: session.claims, active: session.active };
}

/** Runs a session tool, turning a failure (such as an ended session) into a value. */
async function attempt(run: () => Promise<unknown>): Promise<unknown> {
    try {
        return await run();
    } catch (error) {
        return { error: (error as Error).message };
    }
}

/** The session tools of one MCP connection. */
export function sessionTools(scope: SessionScope): Tools {
    const { id, store } = scope;
    const self = async () => {
        const session = await store.get(id);
        if (!session) throw new Error(`The session ${id} has ended.`);
        return session;
    };
    return {
        session_set_label: define({
            description: 'Set the static label of your session: what it is about, in a few words, such as "Invoice entity and its payment flow". The tab shows it until you or the person change it. Set it after reading the first prompt.',
            input: { label: z.string().min(1).max(80) },
            run: (_, input) => attempt(async () => brief(await store.update(id, { label: input.label })))
        }),
        session_set_status: define({
            description: 'Set the status of your session, shown as the colour of its tab: working, blocked, needs-input, done or failed, with a note that says why or what is done.',
            input: { status: z.enum(SESSION_STATUSES), note: z.string().optional() },
            run: (_, input) => attempt(async () => brief(await store.update(id, { status: input.status, note: input.note ?? '' })))
        }),
        session_claim: define({
            description: 'Claim the model elements and files you work on, so other sessions leave them alone. Returns the claims of other sessions that overlap; settle those with the other session before you change anything.',
            input: claimsInput,
            run: (_, input) => attempt(async () => {
                const conflicts = findConflicts(await store.list(), await self(), input as Partial<Claims>);
                const session = await store.claim(id, input as Partial<Claims>);
                return { claims: session.claims, ...(conflicts.length ? { conflicts, warning: conflictWarning(conflicts) } : {}) };
            })
        }),
        session_release: define({
            description: 'Release claimed elements and files. Without elements and files: every claim of the session.',
            input: claimsInput,
            run: (_, input) => attempt(async () => {
                const session = await store.release(id, input.elements || input.files ? input as Partial<Claims> : undefined);
                return { claims: session.claims };
            })
        }),
        sessions_list: define({
            description: 'The other agent sessions of the workspace with their label, status, claims and last tool call, and your own session.',
            input: {},
            run: () => attempt(async () => {
                const session = await self();
                return { self: brief(session), others: peers(await store.list(), session).map(brief) };
            })
        }),
        session_message: define({
            description: 'Send a message to another session of the workspace, named by its id or its label, such as to ask it to release a claim or to tell it what you changed. It reads the message with session_inbox.',
            input: { to: z.string().describe('The session id or label'), text: z.string().min(1) },
            run: (_, input) => attempt(async () => ({ sent: true, to: await store.send(id, input.to, input.text) }))
        }),
        session_inbox: define({
            description: 'Read the messages other sessions sent you; reading them marks them read.',
            input: {},
            run: () => attempt(async () => ({ messages: await store.inbox(id) }))
        }),
        ide_context: define({
            description: 'What the IDE shows: your own tab, the repo and workspace, the open tabs, the canvas view and the selected element. Read it when the person refers to "this" or "here".',
            input: {},
            run: () => attempt(async () => {
                const session = await self();
                return scope.host ? scope.host.context(session) : { repo: session.repo, workspace: session.workspace };
            })
        }),
        ide_act: define({
            description: 'Act on the IDE to show the person something: focus (show your session\'s tab), open (an element or a file, with line), highlight (mark elements on the canvas), reveal (select an element on the canvas and in the source).',
            input: {
                action: z.enum(['focus', 'open', 'highlight', 'reveal']),
                elements: z.array(z.string()).optional().describe('Qualified names, for open, highlight and reveal'),
                file: z.string().optional().describe('open: a file, relative to the repo'),
                line: z.number().int().min(1).optional()
            },
            run: (_, input) => attempt(async () => scope.host ? scope.host.act(await self(), input as IdeAction) : { ok: false, reason: 'No IDE is attached to this session.' })
        })
    };
}

export function conflictWarning(conflicts: ClaimConflict[]): string {
    const lines = conflicts.map(c => `${c.touched} touches ${c.claimed}, claimed by session "${c.label}" (${c.session})`);
    return `This touches what other sessions claimed: ${lines.join('; ')}. Settle it with them through session_message before you go on.`;
}

/** The elements and files a model tool call touches, for the claim check. */
export function touchedBy(tool: string, input: Record<string, unknown>, result: unknown): Partial<Claims> {
    const changed = (result as { changed?: unknown })?.changed;
    const files = Array.isArray(changed) ? changed.filter((f): f is string => typeof f === 'string') : [];
    if (tool === 'edit') {
        const operation = input.operation as EditOperation;
        return { elements: [operation.op === 'add' ? operation.parent : operation.target], files };
    }
    if (tool === 'propose_edits') {
        const operations = (input.operations ?? []) as EditOperation[];
        return { elements: operations.map(o => (o.op === 'add' ? o.parent : o.target)), files };
    }
    if (tool === 'write_model_file') return { files: [String(input.path)] };
    return {};
}

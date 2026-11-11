import { STATUS_COLORS, STATUS_LABELS, waiting, type AgentPrompt, type AgentStatus } from '@appling/ai/agents';

/**
 * The session board (#10): every agent session of every workspace and repo with its label, status colour, repo and
 * duration, the ones waiting for the user first; plus what the rail shows of a repo's sessions and when a session
 * that needs input deserves a desktop notification. Pure.
 */

/** What the board and the rail need of a session. */
export interface SessionView {
    id: string;
    /** The agent's name, the tab's label until the agent (or the user) sets one. */
    name: string;
    label?: string;
    status: AgentStatus;
    note?: string;
    prompt?: AgentPrompt;
    /** The session's own colour (its claims on the canvas). */
    color: string;
    repo: string;
    workspace?: string;
    started: string;
    /** When it exited. */
    ended?: string;
}

export interface BoardEntry {
    id: string;
    title: string;
    name: string;
    status: AgentStatus;
    statusLabel: string;
    /** The status colour. */
    statusColor: string;
    color: string;
    repo: string;
    repoName: string;
    workspace?: string;
    workspaceName?: string;
    duration: string;
    note?: string;
    prompt?: AgentPrompt;
    /** The session whose tab is shown in the active repo. */
    active: boolean;
}

/** Waiting sessions first, then failed, working, done, exited. */
const ORDER: AgentStatus[] = ['needs-input', 'blocked', 'failed', 'working', 'done', 'exited'];

export interface BoardContext {
    repoName(repo: string): string;
    workspaceName(workspace: string): string | undefined;
    /** The shown session of the active repo. */
    active?: string;
    now?: Date;
}

export function sessionTitle(session: Pick<SessionView, 'label' | 'name'>): string {
    return session.label ?? session.name;
}

export function boardEntries(sessions: readonly SessionView[], context: BoardContext): BoardEntry[] {
    const now = (context.now ?? new Date()).getTime();
    return [...sessions]
        .sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || a.started.localeCompare(b.started))
        .map(session => ({
            id: session.id,
            title: sessionTitle(session),
            name: session.name,
            status: session.status,
            statusLabel: STATUS_LABELS[session.status],
            statusColor: STATUS_COLORS[session.status],
            color: session.color,
            repo: session.repo,
            repoName: context.repoName(session.repo),
            ...session.workspace ? { workspace: session.workspace, workspaceName: context.workspaceName(session.workspace) } : {},
            duration: formatDuration((session.ended ? Date.parse(session.ended) : now) - Date.parse(session.started)),
            ...session.note ? { note: session.note } : {},
            ...session.prompt ? { prompt: session.prompt } : {},
            active: session.id === context.active
        }));
}

/** `42s`, `5m`, `1h 05m`, `2d 3h`. */
export function formatDuration(ms: number): string {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
    return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** A session as a dot under its repo's rail button. */
export interface RailSession {
    id: string;
    title: string;
    status: AgentStatus;
    statusColor: string;
    color: string;
    active: boolean;
    prompt?: AgentPrompt;
}

/** The repo's sessions for the rail, in the board's order; `active` marks the one whose tab is shown. */
export function railSessions(sessions: readonly SessionView[], repo: string, active?: string): RailSession[] {
    return boardEntries(sessions.filter(s => s.repo === repo), { repoName: () => '', workspaceName: () => undefined, active })
        .map(entry => ({ id: entry.id, title: entry.title, status: entry.status, statusColor: entry.statusColor, color: entry.color, active: entry.active, ...entry.prompt ? { prompt: entry.prompt } : {} }));
}

/** What the user sees right now, to decide whether a waiting session needs a desktop notification. */
export interface Attention {
    /** Whether a window of the app has the focus. */
    focused: boolean;
    /** The repos shown in some window. */
    shown: ReadonlySet<string>;
    /** The workspaces shown in some window. */
    workspaces: ReadonlySet<string>;
    /** The session tabs shown in an open terminal panel. */
    visible: ReadonlySet<string>;
}

/**
 * Whether a session that just started waiting deserves a notification: when the app is in the background, or the
 * session's repo or workspace is not shown, or its tab is hidden.
 */
export function shouldNotify(session: Pick<SessionView, 'id' | 'repo' | 'workspace' | 'status'>, attention: Attention): boolean {
    if (!waiting(session.status)) return false;
    if (!attention.focused) return true;
    if (session.workspace && !attention.workspaces.has(session.workspace)) return true;
    if (!attention.shown.has(session.repo)) return true;
    return !attention.visible.has(session.id);
}

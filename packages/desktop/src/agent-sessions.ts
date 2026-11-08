import { MemorySessionStore, type AgentSession, type AppHost, type IdeAction, type IdeContext } from '@appling/ai';
import type { Workspaces } from './workspaces.js';

/**
 * The agent sessions of every open workspace, in the main process. Every repo's IDE server reaches this one store over
 * its IPC channel (`startIdeProcess` with `sessions`), so the sessions of a workspace see each other's labels, status
 * and claims across its repos. A session belongs to a workspace (the id of its `.code-workspace` file) and works in
 * one repo.
 */
export function agentSessions(): MemorySessionStore {
    return new MemorySessionStore();
}

/**
 * Opens a session for an agent started in a terminal of a repo. The agent's MCP config gets the repo server's MCP URL
 * and the token as bearer token.
 */
export async function openAgentSession(store: MemorySessionStore, input: { name: string, repo: string, workspace?: string, mcp: string }) {
    const { session, token } = await store.open(input);
    return { session, token, mcp: input.mcp, headers: { Authorization: `Bearer ${token}` } };
}

export interface DesktopHostOptions {
    /** The tabs of the session's workspace; they come with the agent terminals (#10). */
    tabs?(session: AgentSession): NonNullable<IdeContext['tabs']>;
    /** Shows the session's tab; returns whether it could. */
    focus?(session: AgentSession): boolean;
}

/** What the app adds to a session's IDE context (the active repo and workspace, the tabs) and the focus action. */
export function desktopHost(workspaces: Workspaces, options: DesktopHostOptions = {}): AppHost {
    return {
        async context(session) {
            const workspace = session.workspace ? workspaces.get(session.workspace) : workspaces.current();
            return {
                activeRepo: workspaces.activeRepo(),
                workspace: workspace?.id,
                ...(options.tabs ? { tabs: options.tabs(session) } : {})
            };
        },
        async act(session: AgentSession, action: IdeAction) {
            return action.action === 'focus' ? options.focus?.(session) ?? false : false;
        }
    };
}

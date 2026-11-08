import { sessionTitle, type AppHost, type IdeContext, type IdeHost } from '@appling/ai';

/** What the IDE client last reported it shows. */
export interface ClientContext {
    selection?: string;
    view?: Record<string, unknown>;
    file?: string;
    /** The agent session whose view (visual tools) the canvas shows, when the user opened one. */
    watching?: string;
}

/**
 * The IDE host of this server's sessions: the context is the client's report over the app's part; actions go to
 * every open client over `/events` as `{ type: 'act', session, color, ...action }` and to the app.
 */
export function ideHost(root: string, client: ClientContext, clients: () => number, broadcast: (message: unknown) => void, desktop?: AppHost): IdeHost {
    return {
        async context(session) {
            const own: IdeContext = {
                repo: root, workspace: session.workspace,
                tab: { id: session.id, title: sessionTitle(session), status: session.status, active: false },
                ...client
            };
            return { ...own, ...await desktop?.context?.(session) };
        },
        async act(session, action) {
            if ((action.action === 'open' || action.action === 'reveal') && !action.elements?.length && !action.file) {
                return { ok: false, reason: `${action.action} needs elements or a file.` };
            }
            if (action.action === 'highlight' && !action.elements) return { ok: false, reason: 'highlight needs elements; an empty list clears them.' };
            const open = clients();
            if (action.action !== 'focus') broadcast({ type: 'act', session: session.id, color: session.color, ...action });
            const handled = await desktop?.act?.(session, action) ?? false;
            if (handled || (open && action.action !== 'focus')) return { ok: true };
            return { ok: false, reason: action.action === 'focus' ? 'Only Appling Desktop can focus a tab.' : 'No IDE window is open.' };
        }
    };
}

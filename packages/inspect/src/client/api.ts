import type { Review, Revision } from '../shared/review.js';
import { DEFAULT_VIEW, type ClientReport, type IdeEvents, type Snapshot, type ViewSettings } from '../shared/snapshot.js';

export async function loadSnapshot(): Promise<Snapshot> {
    return (await fetch('/api/snapshot')).json();
}

/** The stored view settings over the defaults, so settings added later get their default. */
export async function loadView(): Promise<ViewSettings> {
    return { ...DEFAULT_VIEW, ...await (await fetch('/api/view')).json() };
}

export async function saveView(view: ViewSettings): Promise<void> {
    await fetch('/api/view', { method: 'PUT', body: JSON.stringify(view) });
}

/**
 * Calls back with what the server pushes: every new snapshot after files change on disk, the agent sessions and
 * their actions. `report` tells the server what the client shows.
 */
export function onEvents(handlers: IdeEvents): { close(): void, report(report: ClientReport): void } {
    const socket = new WebSocket(`ws://${location.host}/events`);
    let pending: ClientReport | undefined;
    socket.onopen = () => {
        if (pending) socket.send(JSON.stringify({ type: 'context', ...pending }));
    };
    socket.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.type === 'snapshot') handlers.snapshot(message.snapshot);
        if (message.type === 'sessions') handlers.sessions?.(message.sessions);
        if (message.type === 'act') handlers.act?.(message);
        if (message.type === 'live') handlers.live?.(message.live);
        if (message.type === 'agent-view') handlers.agentView?.(message.view, !!message.ended);
    };
    return {
        close: () => socket.close(),
        report: report => {
            pending = report;
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'context', ...report }));
        }
    };
}

/** Sends an agent session a question typed in its view; it reaches the session's inbox as a message from User. */
export async function askSession(session: string, text: string): Promise<void> {
    const response = await fetch(`/api/sessions/${encodeURIComponent(session)}/ask`, { method: 'POST', body: JSON.stringify({ text }) });
    if (!response.ok) throw new Error(await response.text());
}

export async function loadRelease(): Promise<{ version: string, created: string } | null> {
    return (await fetch('/api/release')).json();
}

/** The model at a revision against the working tree, with the changed files. */
export async function loadReview(rev: string): Promise<Review> {
    return (await fetch(`/api/diff?rev=${encodeURIComponent(rev)}`)).json();
}

export async function loadRevisions(): Promise<Revision[]> {
    return (await fetch('/api/revisions')).json();
}


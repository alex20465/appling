import type { ElementRequest } from '@appling/ai';
import type { EditOperation, EditResult } from '@appling/model';
import type { FileDiff, Review, Revision } from '../shared/review.js';
import type { Decision, LiveChanges } from '../shared/live.js';
import type { GenerationSelection } from '@appling/codegen';
import { DEFAULT_VIEW, type ClientReport, type GenerationRun, type IdeEvents, type Snapshot, type ViewSettings } from '../shared/snapshot.js';
import { monaco } from './monaco.js';

/** In Appling Desktop the repo view opens with the canvas as its main area and the source folded behind **Source**. */
export const SOURCE_OPEN = false;

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

export async function saveFile(path: string, text: string): Promise<void> {
    const response = await fetch(`/api/file?path=${encodeURIComponent(path)}`, { method: 'PUT', body: text });
    if (!response.ok) throw new Error(await response.text());
}

/**
 * Calls back with what the server pushes: every new snapshot after files change on disk, the agent sessions and
 * their actions. `report` tells the server what the client shows, `unsaved` which files have unsaved edits (Appling
 * Desktop shows them on the rail).
 */
export function onEvents(handlers: IdeEvents): { close(): void, report(report: ClientReport): void, unsaved(files: string[]): void } {
    const socket = new WebSocket(`ws://${location.host}/events`);
    let pending: ClientReport | undefined;
    let unsaved: string[] | undefined;
    socket.onopen = () => {
        if (pending) socket.send(JSON.stringify({ type: 'context', ...pending }));
        if (unsaved) socket.send(JSON.stringify({ type: 'unsaved', files: unsaved }));
    };
    socket.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.type === 'snapshot') handlers.snapshot(message.snapshot);
        if (message.type === 'sessions') handlers.sessions?.(message.sessions);
        if (message.type === 'act') handlers.act?.(message);
        if (message.type === 'live') handlers.live?.(message.live);
        if (message.type === 'agent-view') handlers.agentView?.(message.view, !!message.ended);
        if (message.type === 'proposals') handlers.proposals?.(message.proposals);
        if (message.type === 'generation') handlers.generation?.(message.run);
        if (message.type === 'generation-event') handlers.generationEvent?.(message.id, message.event);
    };
    return {
        close: () => socket.close(),
        report: report => {
            pending = report;
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'context', ...report }));
        },
        unsaved: files => {
            unsaved = files;
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'unsaved', files }));
        }
    };
}

/** Starts a generation run through the targets of `appling.config.json`; the run then streams over the events. */
export async function startGeneration(selection: GenerationSelection): Promise<GenerationRun> {
    const response = await fetch('/api/generate', { method: 'POST', body: JSON.stringify({ selection }) });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
}

/** Adds the stack's target to appling.config.json. */
export async function addTarget(stack: string): Promise<void> {
    const response = await fetch('/api/targets', { method: 'POST', body: JSON.stringify({ stack }) });
    if (!response.ok) throw new Error(await response.text());
}

/** The text of a code file of the workspace or a generate target, read only. */
export async function loadCode(path: string): Promise<{ path: string, text: string }> {
    const response = await fetch(`/api/code?path=${encodeURIComponent(path)}`);
    if (!response.ok) throw new Error(await response.text());
    return response.json();
}

/** Accepts the live changes of these files, or of every changed file: they stop being marked. */
export async function acceptChanges(paths?: string[]): Promise<LiveChanges> {
    return (await fetch('/api/live/accept', { method: 'POST', body: JSON.stringify({ paths }) })).json();
}

/** Writes a changed file's text as last accepted back to disk. */
export async function revertChange(path: string): Promise<void> {
    const response = await fetch('/api/live/revert', { method: 'POST', body: JSON.stringify({ path }) });
    if (!response.ok) throw new Error(await response.text());
}

/** Answers an agent session's waiting propose_edits call. */
export async function decideProposal(id: string, decision: Decision): Promise<void> {
    const response = await fetch(`/api/proposals/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify({ decision }) });
    if (!response.ok) throw new Error(await response.text());
}

/** Sends an agent session a question typed in its view; it reaches the session's inbox as a message from User. */
export async function askSession(session: string, text: string): Promise<void> {
    const response = await fetch(`/api/sessions/${encodeURIComponent(session)}/ask`, { method: 'POST', body: JSON.stringify({ text }) });
    if (!response.ok) throw new Error(await response.text());
}

/** Asks an agent for an element by name, description and kind (`.appling/requests.json`); the snapshot shows it. */
export async function addRequest(request: { name: string, description: string, kind?: string, parent?: string, parentRequest?: string }): Promise<ElementRequest> {
    const response = await fetch('/api/requests', { method: 'POST', body: JSON.stringify(request) });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
}

export async function updateRequest(id: string, change: { name?: string, description?: string, kind?: string }): Promise<void> {
    const response = await fetch(`/api/requests/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(change) });
    if (!response.ok) throw new Error(await response.text());
}

export async function removeRequest(id: string): Promise<void> {
    const response = await fetch(`/api/requests/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!response.ok) throw new Error(await response.text());
}

export async function requestEdit(sources: Record<string, string>, operation: EditOperation): Promise<EditResult> {
    return (await fetch('/api/edit', { method: 'POST', body: JSON.stringify({ sources, operation }) })).json();
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

export async function loadFileDiff(rev: string, path: string, before = path): Promise<FileDiff | { error: string }> {
    return (await fetch(`/api/diff/file?rev=${encodeURIComponent(rev)}&path=${encodeURIComponent(path)}&before=${encodeURIComponent(before)}`)).json();
}

/** Connects Monaco's own LSP client to the language server; it keeps every open model in sync. */
export async function connectLanguageServer(): Promise<void> {
    const transport = await monaco.lsp.WebSocketTransport.connectTo({ address: `ws://${location.host}/lsp` });
    new monaco.lsp.MonacoLspClient(transport);
}

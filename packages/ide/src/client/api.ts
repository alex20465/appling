import type { ChatEvent } from '@appling/ai';
import type { EditOperation, EditResult } from '@appling/model';
import type { FileDiff, Review, Revision } from '../shared/review.js';
import type { Decision, LiveChanges } from '../shared/live.js';
import { DEFAULT_VIEW, type ClientReport, type IdeEvents, type Snapshot, type ViewSettings } from '../shared/snapshot.js';
import { monaco } from './monaco.js';

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

/** Streams the events of one chat turn: text, tool calls, a proposal, errors. */
export async function* chatTurn(messages: { role: 'user' | 'assistant', content: string }[]): AsyncGenerator<ChatEvent> {
    const response = await fetch('/api/chat', { method: 'POST', body: JSON.stringify({ messages }) });
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        buffer += chunk.value;
        const lines = buffer.split('\n');
        buffer = lines.pop()!;
        for (const line of lines.filter(Boolean)) yield JSON.parse(line) as ChatEvent;
    }
}

/** Connects Monaco's own LSP client to the language server; it keeps every open model in sync. */
export async function connectLanguageServer(): Promise<void> {
    const transport = await monaco.lsp.WebSocketTransport.connectTo({ address: `ws://${location.host}/lsp` });
    new monaco.lsp.MonacoLspClient(transport);
}

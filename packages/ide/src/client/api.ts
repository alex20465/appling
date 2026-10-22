import type { ChatEvent } from '@appling/ai';
import type { EditOperation, EditResult } from '@appling/model';
import type { Layout, Snapshot } from '../shared/snapshot.js';

export async function loadSnapshot(): Promise<Snapshot> {
    return (await fetch('/api/snapshot')).json();
}

export async function loadLayout(): Promise<Layout> {
    return (await fetch('/api/layout')).json();
}

export async function saveLayout(layout: Layout): Promise<void> {
    await fetch('/api/layout', { method: 'PUT', body: JSON.stringify(layout) });
}

export async function saveFile(path: string, text: string): Promise<void> {
    const response = await fetch(`/api/file?path=${encodeURIComponent(path)}`, { method: 'PUT', body: text });
    if (!response.ok) throw new Error(await response.text());
}

/** Calls back with every new snapshot the server pushes after files change on disk. */
export function onSnapshot(callback: (snapshot: Snapshot) => void): () => void {
    const socket = new WebSocket(`ws://${location.host}/events`);
    socket.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.type === 'snapshot') callback(message.snapshot);
    };
    return () => socket.close();
}

export async function requestEdit(sources: Record<string, string>, operation: EditOperation): Promise<EditResult> {
    return (await fetch('/api/edit', { method: 'POST', body: JSON.stringify({ sources, operation }) })).json();
}

export async function loadRelease(): Promise<{ version: string, created: string } | null> {
    return (await fetch('/api/release')).json();
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

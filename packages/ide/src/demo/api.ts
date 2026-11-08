import type { ChatEvent } from '@appling/ai';
import { applyEdit, type EditOperation, type EditResult } from '@appling/model/edit';
import { buildSnapshot } from '../shared/model.js';
import { DEFAULT_VIEW, type ClientReport, type IdeEvents, type Snapshot, type ViewSettings } from '../shared/snapshot.js';
import { monaco } from '../client/monaco.js';

/**
 * The IDE's server calls answered in the browser, for the demo on the landing site: the workspace is the
 * repository's examples in memory, the language server runs in a worker, and nothing survives a reload.
 */
const ROOT = 'file:///examples';
const texts = import.meta.glob<string>('../../../../examples/*.appling', { query: '?raw', import: 'default', eager: true });
const files = new Map(Object.entries(texts).map(([path, text]) => [path.split('/').pop()!, text]));
const listeners = new Set<(snapshot: Snapshot) => void>();
let view = DEFAULT_VIEW;

export function loadSnapshot(): Promise<Snapshot> {
    return buildSnapshot(ROOT, [...files].map(([path, text]) => ({ uri: `${ROOT}/${path}`, path, text })));
}

export async function loadView(): Promise<ViewSettings> {
    return view;
}

export async function saveView(next: ViewSettings): Promise<void> {
    view = next;
}

export async function saveFile(path: string, text: string): Promise<void> {
    files.set(path, text);
    const snapshot = await loadSnapshot();
    for (const listener of listeners) listener(snapshot);
}

/** The demo has no agent sessions: only snapshots. */
export function onEvents(handlers: IdeEvents): { close(): void, report(report: ClientReport): void } {
    listeners.add(handlers.snapshot);
    return { close: () => listeners.delete(handlers.snapshot), report: () => undefined };
}

export function requestEdit(sources: Record<string, string>, operation: EditOperation): Promise<EditResult> {
    return applyEdit(sources, operation);
}

export async function loadRelease(): Promise<null> {
    return null;
}

export async function* chatTurn(): AsyncGenerator<ChatEvent> {
    yield { type: 'error', message: 'The AI chat needs a model provider. Run the IDE on your machine with an API key: npx @appling/ide models' };
}

export async function connectLanguageServer(): Promise<void> {
    const worker = new Worker(new URL('./language-server.ts', import.meta.url), { type: 'module' });
    new monaco.lsp.MonacoLspClient(monaco.lsp.createTransportToWorker(worker));
}

import type { Playbook } from '@appling/ai';
import { applyEdit, type EditOperation, type EditResult } from '@appling/model/edit';
import { buildSnapshot } from '../shared/model.js';
import type { FileDiff, Review, Revision } from '../shared/review.js';
import type { LiveChanges } from '../shared/live.js';
import { DEFAULT_VIEW, type ClientReport, type IdeEvents, type Snapshot, type ViewSettings } from '../shared/snapshot.js';
import { monaco } from '../client/monaco.js';

/** The demo opens with the source next to the canvas, so the text is in view. */
export const SOURCE_OPEN = true;

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
export function onEvents(handlers: IdeEvents): { close(): void, report(report: ClientReport): void, unsaved(files: string[]): void } {
    listeners.add(handlers.snapshot);
    return { close: () => listeners.delete(handlers.snapshot), report: () => undefined, unsaved: () => undefined };
}

/** The demo marks no live changes and has no agent sessions. */
export async function acceptChanges(): Promise<LiveChanges> {
    return { files: [], diff: { changes: [], added: [], changed: [], removed: [], renamed: {} }, ghosts: { nodes: [], edges: [] } };
}

export async function revertChange(): Promise<void> {}

/** The demo has no generate targets and no code. */
export async function startGeneration(): Promise<never> {
    throw new Error('Generation needs Appling Desktop on your machine: https://appling.tools/docs/tools/desktop/');
}

export async function loadCode(): Promise<never> {
    throw new Error('The demo has no code.');
}

export async function decideProposal(): Promise<void> {}

/** The demo has no agent sessions, so its playbook stays empty. */
export async function loadPlaybook(): Promise<Playbook> {
    return { workspace: ROOT, chapters: [], position: { step: 0 } };
}

export async function movePlaybook(): Promise<Playbook> {
    return loadPlaybook();
}

export async function respondToStep(): Promise<{ delivered: boolean }> {
    return { delivered: false };
}

export function requestEdit(sources: Record<string, string>, operation: EditOperation): Promise<EditResult> {
    return applyEdit(sources, operation);
}

export async function loadRelease(): Promise<null> {
    return null;
}

export async function loadReview(): Promise<Review> {
    return { ok: false, error: 'The review compares the model with a git commit. Open a git repository in Appling Desktop: https://appling.tools/docs/tools/desktop/' };
}

export async function loadRevisions(): Promise<Revision[]> {
    return [];
}

export async function loadFileDiff(): Promise<FileDiff | { error: string }> {
    return { error: 'No git in the demo.' };
}

export async function connectLanguageServer(): Promise<void> {
    const worker = new Worker(new URL('./language-server.ts', import.meta.url), { type: 'module' });
    new monaco.lsp.MonacoLspClient(monaco.lsp.createTransportToWorker(worker));
}

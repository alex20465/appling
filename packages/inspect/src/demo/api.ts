import { buildSnapshot } from '../shared/model.js';
import type { Review, Revision } from '../shared/review.js';
import { DEFAULT_VIEW, type ClientReport, type IdeEvents, type Snapshot, type ViewSettings } from '../shared/snapshot.js';

/**
 * The server calls answered in the browser, for the demo on the landing site: the workspace is the repository's
 * examples in memory, read only like every inspector.
 */
const ROOT = 'file:///examples';
const texts = import.meta.glob<string>('../../../../examples/*.appling', { query: '?raw', import: 'default', eager: true });
const files = Object.entries(texts).map(([path, text]) => ({ uri: `${ROOT}/${path.split('/').pop()}`, path: path.split('/').pop()!, text }));
let view = DEFAULT_VIEW;

export function loadSnapshot(): Promise<Snapshot> {
    return buildSnapshot(ROOT, files);
}

export async function loadView(): Promise<ViewSettings> {
    return view;
}

export async function saveView(next: ViewSettings): Promise<void> {
    view = next;
}

/** The files never change in the demo, and it has no agent sessions. */
export function onEvents(_handlers: IdeEvents): { close(): void, report(report: ClientReport): void } {
    return { close: () => undefined, report: () => undefined };
}

/** The demo has no agent sessions to ask. */
export async function askSession(): Promise<void> {}

export async function loadRelease(): Promise<null> {
    return null;
}

export async function loadReview(): Promise<Review> {
    return { ok: false, error: 'No git in the demo.' };
}

export async function loadRevisions(): Promise<Revision[]> {
    return [];
}

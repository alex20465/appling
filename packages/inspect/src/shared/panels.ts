import type { AgentSession } from '@appling/ai';
import type { GraphDiff } from '@appling/model/diff';
import type { LiveChanges } from './live.js';
import type { ChangedFile, Revision } from './review.js';
import type { Snapshot } from './snapshot.js';

/**
 * The side panels for a host that draws them itself (the VS Code extension's views in its sidebar), in place of the
 * client's side column: the client sends what they show (`PanelState`) after every change and does what they ask
 * (`PanelAction`). Hosts without the `panels` hook keep the side column.
 */
export const PANELS = ['inspector', 'changes', 'review', 'code', 'tasks'] as const;
export type PanelName = typeof PANELS[number];

export interface PanelState {
    /** The snapshot without the file texts. */
    snapshot: Omit<Snapshot, 'files'> & { files: { uri: string, path: string }[] };
    /** The selected element or sub-anchor address. */
    selected?: string;
    live?: LiveChanges;
    sessions: AgentSession[];
    /** The review: whether it marks the canvas (`on` and `marked`), the revision compared with and its result. */
    review: { on: boolean, rev: string, marked: boolean, revisions: Revision[], result?: PanelReview };
}

/** The session that claimed an element or one of its parents, as `overlaps` of `@appling/ai` decides. */
export function claimOf(sessions: AgentSession[], qn: string): AgentSession | undefined {
    return sessions.find(s => s.claims.elements.some(c => c === qn || qn.startsWith(`${c}.`) || c.startsWith(`${qn}.`)));
}

export type PanelReview = { ok: true, commit: string, diff: GraphDiff, files: ChangedFile[] } | { ok: false, error: string };

export type PanelAction =
    | { type: 'select', qn: string }
    /** The text diff of an element the review marks, from the revision. */
    | { type: 'textDiff', qn: string }
    | { type: 'review', on?: boolean, rev?: string, marked?: boolean };

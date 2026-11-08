import type { AgentSession, Playbook, PlaybookPosition } from '@appling/ai';
import type { GenerationSelection } from '@appling/codegen';
import type { GraphDiff } from '@appling/model/diff';
import type { Decision, LiveChanges, Proposal } from './live.js';
import type { ChangedFile, Revision } from './review.js';
import type { GenerationRun, Snapshot } from './snapshot.js';

/**
 * The side panels for a host that draws them itself (the VS Code extension's views in its sidebar), in place of the
 * client's side column: the client sends what they show (`PanelState`) after every change and does what they ask
 * (`PanelAction`). Hosts without the `panels` hook keep the side column.
 */
export const PANELS = ['search', 'inspector', 'changes', 'playbook', 'review', 'code'] as const;
export type PanelName = typeof PANELS[number];

export interface PanelState {
    /** The snapshot without the file texts. */
    snapshot: Omit<Snapshot, 'files'> & { files: { uri: string, path: string }[] };
    /** The selected element or sub-anchor address. */
    selected?: string;
    live?: LiveChanges;
    proposals: Proposal[];
    sessions: AgentSession[];
    playbook?: Playbook;
    /** Whether the canvas plays the playbook. */
    playing: boolean;
    run?: GenerationRun;
    /** The review: whether it marks the canvas (`on` and `marked`), the revision compared with and its result. */
    review: { on: boolean, rev: string, marked: boolean, revisions: Revision[], result?: PanelReview };
    /** The session whose changes the Changes panel shows alone. */
    changesOf?: string;
}

/** The session that claimed an element or one of its parents, as `overlaps` of `@appling/ai` decides. */
export function claimOf(sessions: AgentSession[], qn: string): AgentSession | undefined {
    return sessions.find(s => s.claims.elements.some(c => c === qn || qn.startsWith(`${c}.`) || c.startsWith(`${qn}.`)));
}

export type PanelReview = { ok: true, commit: string, diff: GraphDiff, files: ChangedFile[] } | { ok: false, error: string };

export type PanelAction =
    | { type: 'select', qn: string }
    | { type: 'generate', selection: GenerationSelection }
    /** The text diff of an element the review marks, from the revision. */
    | { type: 'textDiff', qn: string }
    | { type: 'accept', paths?: string[] }
    | { type: 'revert', path: string }
    | { type: 'decide', id: string, decision: Decision }
    | { type: 'play', position: PlaybookPosition }
    | { type: 'session', chapter: string }
    | { type: 'diff', chapter: string }
    | { type: 'review', on?: boolean, rev?: string, marked?: boolean }
    | { type: 'changesOf', session?: string };

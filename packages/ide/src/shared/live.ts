import type { GraphDiff } from '@appling/model/diff';
import type { GraphEdge, GraphNode } from '@appling/model/graph';
import type { Bubble, Decision, Review, Show, Status } from '@appling/viz/protocol';

/** A model file that differs from the baseline, the text the user last accepted. */
export interface LiveFile {
    /** Relative to the workspace folder. */
    path: string;
    status: 'added' | 'modified' | 'deleted';
    /** The text at the baseline; null for a file that did not exist then. */
    before: string | null;
    /** The text on disk now; null for a deleted file. */
    after: string | null;
    /** Qualified names of the model changes in this file: where the element is now, or was, for a removed one. */
    elements: string[];
    /** The agent sessions whose MCP tool calls wrote the file since the baseline; empty for a write by anything else. */
    sessions: string[];
    /** When the file last changed, as an ISO time. */
    at: string;
}

/**
 * Every model change since the baseline: the text the user last accepted, per file, starting from the files on disk
 * when the IDE server started. `diff` compares the whole model at the baseline with the model now.
 */
export interface LiveChanges {
    files: LiveFile[];
    diff: GraphDiff;
    /** The removed elements with their edges, to draw them ghosted on the canvas over the graph now. */
    ghosts: { nodes: GraphNode[], edges: GraphEdge[] };
}

/** What one agent session shows on the canvas with the visual tools; the canvas draws it once the user opens it. */
export interface AgentView {
    session: string;
    show?: Show;
    /** The bubbles of the view, in the order they were placed. */
    bubbles: Bubble[];
    /** What the session works on, the last step last (visual_status). */
    steps: Status[];
    /** Its answers (visual_reply), the last last. */
    replies: string[];
    /** When it last changed, as an ISO time. */
    at: string;
}

/** A change an agent session proposes with propose_edits; its tool call waits until the user decides in the app. */
export interface Proposal {
    id: string;
    session: string;
    review: Review;
    at: string;
}

export type { Decision };

/** The number of unseen changes a repo reports, such as to the rail of Appling Desktop. */
export function unseen(live: LiveChanges | undefined): number {
    return live?.files.length ?? 0;
}

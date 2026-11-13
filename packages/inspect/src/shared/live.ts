import type { GraphDiff } from '@appling/model/diff';
import type { GraphEdge, GraphNode } from '@appling/model/graph';
import type { Bubble, Show, Status } from '@appling/viz/protocol';

/** A model file that differs from the baseline: its text at git `HEAD`, outside git when the server started. */
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
 * Every model change since the baseline: the last commit, outside git the files on disk when the server started.
 * `diff` compares the whole model at the baseline with the model now.
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
    /** The bubbles are the steps of a playbook: the tree grows with each step played. */
    playbook?: boolean;
    /** What the session works on, the last step last (visual_status). */
    steps: Status[];
    /** Its answers (visual_reply), the last last. */
    replies: string[];
    /** The questions the user typed to it in its view, the last last; each reaches its inbox as a message from User. */
    questions?: string[];
    /** When it last changed, as an ISO time. */
    at: string;
}


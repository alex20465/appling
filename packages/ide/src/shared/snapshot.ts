import type { AgentSession, IdeAction } from '@appling/ai';
import type { AgentView, LiveChanges, Proposal } from './live.js';
import type { Dependency, Graph, ResolvedReference } from '@appling/model';

export interface SourceFile {
    uri: string;
    path: string;
    text: string;
}

export interface Location {
    uri: string;
    start: number;
    end: number;
}

/** A code reference with the lines it points at now; empty for a broken one. */
export interface CodeLocation extends ResolvedReference {
    text: string;
}

/** Everything the IDE shows, built from the files on disk. */
export interface Snapshot {
    root: string;
    files: SourceFile[];
    graph: Graph;
    dependencies: Dependency[];
    locations: Record<string, Location>;
    /** Where elements are implemented, by qualified name. */
    code: Record<string, CodeLocation[]>;
    errors: string[];
}

export { DEFAULT_VIEW, type ViewSettings } from '@appling/viz/views';

/** An `ide_act` of an agent session, pushed to the client over `/events`. */
export type SessionAct = IdeAction & { session: string, color: string };

/** What the server pushes over `/events`. */
export interface IdeEvents {
    snapshot(snapshot: Snapshot): void;
    /** Every agent session of the workspace, after each change. */
    sessions?(sessions: AgentSession[]): void;
    act?(act: SessionAct): void;
    /** Every model change since the baseline, after each change. */
    live?(live: LiveChanges): void;
    /** What an agent session shows with the visual tools; `ended` when the session ended. */
    agentView?(view: AgentView, ended: boolean): void;
    /** The proposals waiting for a decision, after each change. */
    proposals?(proposals: Proposal[]): void;
}

/** What the client reports it shows, for the sessions' IDE context. */
export interface ClientReport {
    selection?: string;
    view?: Record<string, unknown>;
    file?: string;
    /** The agent session whose view the canvas shows. */
    watching?: string;
}

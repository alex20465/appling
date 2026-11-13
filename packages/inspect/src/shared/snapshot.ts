import type { AgentSession, IdeAction } from '@appling/ai';
import type { AgentView, LiveChanges } from './live.js';
import type { Dependency, ElementImplementation, Graph, ResolvedReference } from '@appling/model';
import type { TargetState, TargetTask } from '@appling/codegen';

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

/** Everything the inspector shows, built from the files on disk. */
export interface Snapshot {
    root: string;
    files: SourceFile[];
    graph: Graph;
    dependencies: Dependency[];
    locations: Record<string, Location>;
    /** Where elements and sub-anchors are implemented, by qualified name or address. */
    code: Record<string, CodeLocation[]>;
    /** How far each element is implemented, by qualified name; empty without a server. */
    implementation: Record<string, ElementImplementation>;
    /**
     * How far each sub-anchor is implemented (a use case step, a `requires`, a page component…), by its address
     * (`sales.PlaceOrder#step[2]`); `locations` and `code` hold the sub-anchors too. Empty without a server.
     */
    anchors: Record<string, ElementImplementation>;
    /** The generate targets of `appling.config.json`. */
    targets: TargetState[];
    /** The registry tasks of every target, open and done, in plan order. */
    tasks: TargetTask[];
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
}

/** What the client reports it shows, for the sessions' ide_context. */
export interface ClientReport {
    selection?: string;
    view?: Record<string, unknown>;
    /** The agent session whose view the canvas shows. */
    watching?: string;
}

import type { AgentSession, IdeAction, Playbook } from '@appling/ai';
import type { AgentView, LiveChanges, Proposal } from './live.js';
import type { Dependency, ElementImplementation, Graph, ResolvedReference } from '@appling/model';
import type { GenerationEvent, GenerationSelection, TargetState, TargetTask } from '@appling/codegen';

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
    /** How far each element is implemented, by qualified name; empty without a server. */
    implementation: Record<string, ElementImplementation>;
    /** The generate targets of `appling.config.json`. */
    targets: TargetState[];
    /** The open registry tasks of every target. */
    tasks: TargetTask[];
    errors: string[];
}

/** A generation run the IDE started, with its events so far. */
export interface GenerationRun {
    id: string;
    title: string;
    selection: GenerationSelection;
    started: string;
    ended?: string;
    events: GenerationEvent[];
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
    /** The playbook of the workspace the view shows (#19), after each change. */
    playbook?(playbook: Playbook): void;
    /** A generation run started or ended; also the current one on connect. */
    generation?(run: GenerationRun): void;
    /** One event of the running generation. */
    generationEvent?(id: string, event: GenerationEvent): void;
}

/** What the client reports it shows, for the sessions' IDE context. */
export interface ClientReport {
    selection?: string;
    view?: Record<string, unknown>;
    file?: string;
    /** The agent session whose view the canvas shows. */
    watching?: string;
}

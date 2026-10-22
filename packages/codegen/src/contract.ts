import type { Graph, GraphEdge, GraphNode } from '@appling/model';

interface StepOrder {
    /** Steps run by phase, then in plan order. Use a later phase for work that needs every element of an earlier one, such as relationships. */
    phase?: number;
}

/** Runs the target framework's own command line tool, with cwd relative to the output folder. */
export interface CommandStep extends StepOrder {
    kind: 'command';
    run: string[];
    cwd?: string;
    creates?: string[];
}

/** Writes or patches one file, relative to the output folder. `write` gets the current content when the file exists. */
export interface TemplateStep extends StepOrder {
    kind: 'template';
    file: string;
    write: (existing: string | undefined) => string;
}

/** Records work the generator cannot do, for the AI or a human. */
export interface TaskStep {
    kind: 'task';
    what: string;
}

export type Step = CommandStep | TemplateStep | TaskStep;

export interface Prerequisite {
    name: string;
    command: string[];
    expect?: RegExp;
    hint: string;
}

export interface MapContext {
    graph: Graph;
    /** The project name: the `name` option, or the output folder's name. */
    name: string;
    options: Record<string, unknown>;
    node(qn: string): GraphNode | undefined;
    children(qn: string): GraphNode[];
    outgoing(qn: string, kind?: string): GraphEdge[];
    incoming(qn: string, kind?: string): GraphEdge[];
}

/**
 * A code generation extension is a map from graph nodes to steps. Returning `undefined` means the
 * extension does not handle the node kind; an empty list means a parent's steps already cover it.
 */
export interface CodegenExtension {
    name: string;
    prerequisites?: Prerequisite[];
    /** The command that runs the generated project's tests, from its root. */
    test?: string[];
    /** Steps that run once, before any element, such as creating the project. */
    setup?(context: MapContext): Step[];
    steps(node: GraphNode, context: MapContext): Step[] | undefined;
}

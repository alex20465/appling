import type { Graph, GraphNode } from '@appling/model';
import type { CodegenExtension, MapContext, Step } from './contract.js';

export type Status = 'generated' | 'partial' | 'todo' | 'done';

export interface Missing {
    what: string;
    context: {
        props: Record<string, unknown>;
        related: { qn: string, kind: string, edge: string }[];
    };
}

/** One registry entry per graph node: the coverage report and the work queue in one. */
export interface RegistryEntry {
    qn: string;
    kind: string;
    layer: string;
    status: Status;
    steps: string[];
    files: string[];
    missing: Missing[];
}

export interface PlannedStep {
    node: string;
    step: Step;
}

export interface Plan {
    extension: string;
    steps: PlannedStep[];
    entries: RegistryEntry[];
}

/** The node name of setup steps. */
export const PROJECT = '(project)';

const RANK: Record<string, number> = { domain: 1, cross: 2, behavior: 3, application: 4, interface: 5, experience: 6 };

/** Asks the extension for the steps of every node, in dependency order: modules, domain, behavior, application, interfaces, experience. */
export function plan(graph: Graph, extension: CodegenExtension, name: string, options: Record<string, unknown> = {}): Plan {
    const context = mapContext(graph, name, options);
    const ordered = graph.nodes.map((node, index) => ({ node, index }))
        .sort((a, b) => rank(a.node) - rank(b.node) || a.index - b.index)
        .map(({ node }) => node);
    const steps: PlannedStep[] = (extension.setup?.(context) ?? []).map(step => ({ node: PROJECT, step }));
    const entries = ordered.map(node => {
        const nodeSteps = extension.steps(node, context);
        steps.push(...(nodeSteps ?? []).filter(s => s.kind !== 'task').map(step => ({ node: node.qn, step })));
        return entry(node, nodeSteps, extension.name, context);
    });
    const phase = (s: PlannedStep) => s.step.kind === 'task' ? 0 : s.step.phase ?? 0;
    return { extension: extension.name, steps: steps.map((s, i) => ({ s, i })).sort((a, b) => phase(a.s) - phase(b.s) || a.i - b.i).map(({ s }) => s), entries };
}

export function describe(step: Step): string {
    switch (step.kind) {
        case 'command': return `command: ${step.run.join(' ')}${step.cwd ? ` (in ${step.cwd})` : ''}`;
        case 'template': return `template: ${step.file}`;
        case 'task': return `task: ${step.what}`;
    }
}

function entry(node: GraphNode, steps: Step[] | undefined, extension: string, context: MapContext): RegistryEntry {
    const tasks = (steps ?? []).filter(s => s.kind === 'task').map(s => s.what);
    if (!steps) tasks.push(`${extension} does not generate ${node.kind} yet`);
    const work = (steps ?? []).filter(s => s.kind !== 'task');
    const related = [
        ...context.outgoing(node.qn).filter(e => e.kind !== 'contains').map(e => ({ qn: e.to, kind: context.node(e.to)!.kind, edge: e.kind })),
        ...context.incoming(node.qn).filter(e => e.kind !== 'contains').map(e => ({ qn: e.from, kind: context.node(e.from)!.kind, edge: `${e.kind} by` }))
    ];
    return {
        qn: node.qn,
        kind: node.kind,
        layer: node.layer,
        status: tasks.length === 0 ? 'generated' : work.length ? 'partial' : 'todo',
        steps: (steps ?? []).map(describe),
        files: work.flatMap(s => s.kind === 'template' ? [s.file] : s.kind === 'command' ? s.creates ?? [] : []),
        missing: tasks.map(what => ({ what, context: { props: node.props, related } }))
    };
}

function rank(node: GraphNode): number {
    return node.kind === 'Module' ? 0 : RANK[node.layer];
}

export function mapContext(graph: Graph, name: string, options: Record<string, unknown>): MapContext {
    const nodes = new Map(graph.nodes.map(n => [n.qn, n]));
    const outgoing = Map.groupBy(graph.edges, e => e.from);
    const incoming = Map.groupBy(graph.edges, e => e.to);
    return {
        graph,
        name,
        options,
        node: qn => nodes.get(qn),
        children: qn => (outgoing.get(qn) ?? []).filter(e => e.kind === 'contains').map(e => nodes.get(e.to)!),
        outgoing: (qn, kind) => (outgoing.get(qn) ?? []).filter(e => !kind || e.kind === kind),
        incoming: (qn, kind) => (incoming.get(qn) ?? []).filter(e => !kind || e.kind === kind)
    };
}

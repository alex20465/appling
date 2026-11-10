import type { Graph, GraphNode } from '@appling/model';
import type { CodegenExtension, MapContext, Step } from './contract.js';

export type Status = 'generated' | 'partial' | 'todo' | 'done';

export interface Missing {
    what: string;
    leftToCode?: boolean;
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
    /** How often someone tried to finish the open work, and what they noted. */
    attempts?: number;
    notes?: string[];
}

export interface PlannedStep {
    node: string;
    step: Step;
}

export interface Plan {
    extension: string;
    test?: string[];
    syncExclude?: string[];
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
    return { extension: extension.name, test: extension.test, syncExclude: extension.syncExclude, steps: steps.map((s, i) => ({ s, i })).sort((a, b) => phase(a.s) - phase(b.s) || a.i - b.i).map(({ s }) => s), entries };
}

/**
 * Registry entries of one node kind by status, and the registry tasks they leave. Only generator gaps count: an
 * element whose open work is all left to the code counts as generated, and those tasks count in `left`.
 */
export interface CoverageRow {
    kind: string;
    generated: number;
    partial: number;
    todo: number;
    tasks: number;
    left: number;
}

export interface Coverage {
    /** One row per node kind, sorted by kind. */
    kinds: CoverageRow[];
    total: CoverageRow;
}

/** Counts the entries of a plan per node kind and status: how much of the model an extension generates. */
export function coverage(entries: RegistryEntry[]): Coverage {
    const gaps = (e: RegistryEntry) => e.missing.filter(m => !m.leftToCode).length;
    const status = (e: RegistryEntry) => e.missing.length > 0 && gaps(e) === 0 ? 'generated' : e.status;
    const row = (kind: string, of: RegistryEntry[]): CoverageRow => ({
        kind,
        generated: of.filter(e => status(e) === 'generated' || status(e) === 'done').length,
        partial: of.filter(e => status(e) === 'partial').length,
        todo: of.filter(e => status(e) === 'todo').length,
        tasks: of.reduce((sum, e) => sum + gaps(e), 0),
        left: of.reduce((sum, e) => sum + e.missing.length - gaps(e), 0)
    });
    const kinds = [...Map.groupBy(entries, e => e.kind)].sort(([a], [b]) => a.localeCompare(b)).map(([kind, of]) => row(kind, of));
    return { kinds, total: row('total', entries) };
}

/** The coverage as a Markdown table, the last line being the total with the generated share. */
export function coverageTable({ kinds, total }: Coverage): string {
    const all = total.generated + total.partial + total.todo;
    const share = all ? ` (${Math.round(total.generated / all * 100)}%)` : '';
    const line = (r: CoverageRow, label = r.kind, suffix = '') => `| ${label} | ${r.generated}${suffix} | ${r.partial} | ${r.todo} | ${r.tasks} | ${r.left} |`;
    return ['| kind | generated | partial | todo | tasks | left to code |', '|---|---|---|---|---|---|', ...kinds.map(r => line(r)), line(total, '**total**', share)].join('\n');
}

export function describe(step: Step): string {
    switch (step.kind) {
        case 'command': return `command: ${step.run.join(' ')}${step.cwd ? ` (in ${step.cwd})` : ''}`;
        case 'template': return `template: ${step.file}`;
        case 'task': return `task: ${step.what}`;
    }
}

function entry(node: GraphNode, steps: Step[] | undefined, extension: string, context: MapContext): RegistryEntry {
    const tasks = (steps ?? []).filter(s => s.kind === 'task').map(({ what, leftToCode }) => ({ what, leftToCode }));
    if (!steps) tasks.push({ what: `${extension} does not generate ${node.kind} yet`, leftToCode: undefined });
    // Code exists when the node has its own steps or is covered by its parent's (`[]`) and leaves no task of its own.
    const work = (steps ?? []).filter(s => s.kind !== 'task');
    const hasCode = work.length > 0 || (steps !== undefined && tasks.length === 0);
    // The `does` text is prose the model does not formalize, so implementing it is left to the code.
    const does = doesTask(node);
    if (does) tasks.push({ what: does, leftToCode: true });
    const related = [
        ...context.outgoing(node.qn).filter(e => e.kind !== 'contains').map(e => ({ qn: e.to, kind: context.node(e.to)!.kind, edge: e.kind })),
        ...context.incoming(node.qn).filter(e => e.kind !== 'contains').map(e => ({ qn: e.from, kind: context.node(e.from)!.kind, edge: `${e.kind} by` }))
    ];
    return {
        qn: node.qn,
        kind: node.kind,
        layer: node.layer,
        status: tasks.length === 0 ? 'generated' : hasCode ? 'partial' : 'todo',
        steps: (steps ?? []).map(describe),
        files: work.flatMap(s => s.kind === 'template' ? [s.file] : s.kind === 'command' ? s.creates ?? [] : []),
        missing: tasks.map(({ what, leftToCode }) => ({ what, ...leftToCode && { leftToCode }, context: { props: node.props, related } }))
    };
}

/** Kinds whose `does` text describes work to implement; on every other kind it describes what to check. */
const ACTING = new Set(['Action', 'Machine', 'Job', 'Query', 'External', 'ExternalOperation', 'UseCase']);

/** The registry task of a node's `does` text, the same for every extension. */
export function doesTask(node: GraphNode): string | undefined {
    // A scenario's text describes its example, and its generated test is what checks it.
    if (node.kind === 'Scenario') return undefined;
    const text = node.data.does;
    if (typeof text !== 'string' || !text.trim()) return undefined;
    const name = node.qn.split('.').pop();
    return ACTING.has(node.kind) ? `implement what ${name} does: ${text}` : `check that ${name} matches its description: ${text}`;
}

/** Modules first; scenarios last, as their tests call what every layer generates. */
function rank(node: GraphNode): number {
    if (node.kind === 'Module') return 0;
    return node.kind === 'Scenario' ? 7 : RANK[node.layer];
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

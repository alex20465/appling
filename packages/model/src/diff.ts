import type { Graph, GraphEdge, GraphNode } from './graph.js';

export type ChangeStatus = 'added' | 'changed' | 'removed';

/** One element that differs between two graphs. */
export interface ElementChange {
    status: ChangeStatus;
    /** The qualified name now; for a removed element, the one it had before. */
    qn: string;
    /** The qualified name before, when a migration step renamed the element or one of its parents. */
    was?: string;
    kind: string;
    module: string;
    /** The properties that differ (`kind` when the element became another kind); every property for added and removed elements. */
    props: string[];
    /** Outgoing edges, other than `contains`, that only the graph after or only the graph before has. */
    edges: { added: GraphEdge[], removed: GraphEdge[] };
}

/** The differences between two graphs, keyed by qualified name. */
export interface GraphDiff {
    /** Every change: added and changed elements in the order of the graph after, then the removed ones in the order of the graph before. */
    changes: ElementChange[];
    added: string[];
    changed: string[];
    removed: string[];
    /** The qualified name before of every element that a migration step renamed, by its name now. */
    renamed: Record<string, string>;
}

interface Step {
    $type: 'RenameStep' | 'RetypeStep' | 'RemoveStep';
    target: string;
    newName?: string;
}

/**
 * Compares two semantic graphs, such as the model at a commit and in the working tree. Elements match by qualified
 * name; the migration steps the graph after adds over the graph before map the old names to the new ones, so a
 * renamed element is one change instead of a removal and an addition. An element changed when its properties or its
 * outgoing edges (other than `contains`, which its added and removed members already show) differ.
 */
export function diffGraphs(before: Graph, after: Graph): GraphDiff {
    const follow = migrationRenames(before, after);
    const now = new Map(after.nodes.map(n => [n.qn, n]));
    const matched = new Map<string, GraphNode>();
    const removed: GraphNode[] = [];
    const renamed: Record<string, string> = {};
    for (const node of before.nodes) {
        const qn = follow(node.qn);
        if (qn && now.has(qn) && !matched.has(qn)) {
            matched.set(qn, node);
            if (qn !== node.qn) renamed[qn] = node.qn;
        } else removed.push(node);
    }
    const outgoing = (edges: GraphEdge[], map: (qn: string) => string) => {
        const result = new Map<string, Map<string, GraphEdge>>();
        for (const edge of edges) {
            if (edge.kind === 'contains') continue;
            const mapped = { from: map(edge.from), to: map(edge.to), kind: edge.kind };
            const own = result.get(mapped.from) ?? new Map<string, GraphEdge>();
            own.set(`${mapped.kind} ${mapped.to}`, mapped);
            result.set(mapped.from, own);
        }
        return result;
    };
    const edgesNow = outgoing(after.edges, qn => qn);
    const edgesBefore = outgoing(before.edges, qn => follow(qn) ?? qn);
    const noEdges = new Map<string, GraphEdge>();

    const changes: ElementChange[] = [];
    for (const node of after.nodes) {
        const old = matched.get(node.qn);
        const [mine, theirs] = [edgesNow.get(node.qn) ?? noEdges, old ? edgesBefore.get(node.qn) ?? noEdges : noEdges];
        const edges = {
            added: [...mine].filter(([key]) => !theirs.has(key)).map(([, e]) => e),
            removed: [...theirs].filter(([key]) => !mine.has(key)).map(([, e]) => e)
        };
        const base = { qn: node.qn, kind: node.kind, module: node.module, edges };
        if (!old) {
            changes.push({ status: 'added', ...base, props: Object.keys(node.props) });
            continue;
        }
        const props = changedProps(old, node);
        if (props.length || edges.added.length || edges.removed.length || renamed[node.qn]) {
            changes.push({ status: 'changed', ...base, props, ...(renamed[node.qn] && { was: renamed[node.qn] }) });
        }
    }
    for (const node of removed) {
        const edges = { added: [], removed: [...(edgesBefore.get(follow(node.qn) ?? node.qn) ?? noEdges).values()] };
        changes.push({ status: 'removed', qn: node.qn, kind: node.kind, module: node.module, props: Object.keys(node.props), edges });
    }
    const of = (status: ChangeStatus) => changes.filter(c => c.status === status).map(c => c.qn);
    return { changes, added: of('added'), changed: of('changed'), removed: of('removed'), renamed };
}

/**
 * The graph after with the removed elements of a diff put back where they were: each under its parent (mapped to
 * its name now) with its edges, so a canvas can draw it ghosted in its old place.
 */
export function withRemoved(before: Graph, after: Graph, diff: GraphDiff): Graph {
    if (!diff.removed.length) return after;
    const gone = new Set(diff.removed);
    const was = new Map(Object.entries(diff.renamed).map(([now, old]) => [old, now]));
    const known = new Set([...after.nodes.map(n => n.qn), ...gone]);
    const map = (qn: string) => gone.has(qn) ? qn : was.get(qn) ?? qn;
    const seen = new Set(after.edges.map(e => `${e.from} ${e.kind} ${e.to}`));
    const edges = before.edges
        .filter(e => gone.has(e.from) || gone.has(e.to))
        .map(e => ({ from: map(e.from), to: map(e.to), kind: e.kind }))
        .filter(e => known.has(e.from) && known.has(e.to) && !seen.has(`${e.from} ${e.kind} ${e.to}`));
    return { nodes: [...after.nodes, ...before.nodes.filter(n => gone.has(n.qn))], edges: [...after.edges, ...edges] };
}

/**
 * Maps a qualified name of the graph before to its name in the graph after by the migration steps that only the graph
 * after has, in declaration order per module. Undefined for an element such a step removes.
 */
export function migrationRenames(before: Graph, after: Graph): (qn: string) => string | undefined {
    const known = new Set(stepsOf(before).map(s => s.key));
    const fresh = Map.groupBy(stepsOf(after).filter(s => !known.has(s.key)), s => s.module);
    if (!fresh.size) return qn => qn;
    return qn => {
        for (const [module, steps] of fresh) {
            if (!qn.startsWith(`${module}.`)) continue;
            let path: string | undefined = qn.slice(module.length + 1);
            for (const { step } of steps) {
                if (path !== step.target && !path.startsWith(`${step.target}.`)) continue;
                if (step.$type === 'RemoveStep') return undefined;
                if (step.$type === 'RenameStep' && step.newName) path = step.target.replace(/[^.]+$/, step.newName) + path.slice(step.target.length);
            }
            return `${module}.${path}`;
        }
        return qn;
    };
}

/** Every migration step with its module and a key of its place and content, in declaration order. */
function stepsOf(graph: Graph): { module: string, key: string, step: Step }[] {
    return graph.nodes.filter(n => n.kind === 'Migration').flatMap(m => ((m.data.steps ?? []) as Step[])
        .map((step, index) => ({ module: m.module, key: `${m.qn}#${index} ${JSON.stringify(step)}`, step })));
}

function changedProps(before: GraphNode, after: GraphNode): string[] {
    const keys = new Set([...Object.keys(before.props), ...Object.keys(after.props)]);
    const changed = [...keys].filter(key => JSON.stringify(before.props[key]) !== JSON.stringify(after.props[key]));
    return before.kind === after.kind ? changed : ['kind', ...changed];
}

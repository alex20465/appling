import { AstUtils, isAstNode, isReference, type AstNode, type Reference, type ReferenceInfo } from 'langium';
import {
    LAYER_OF, isCreateEffect, isEmitEffect, isEndpoint, isInvariant, isPolicy, isSetEffect, isTransition, modulePath, print,
    type Layer, type Model, type Module
} from '@appling/lang';

export type Level = 'out' | 'medium' | 'in';

export interface GraphNode {
    qn: string;
    kind: string;
    layer: Layer;
    level: Level;
    module: string;
    props: Record<string, unknown>;
}

export interface GraphEdge {
    from: string;
    to: string;
    kind: string;
}

export interface Graph {
    nodes: GraphNode[];
    edges: GraphEdge[];
}

export interface Dependency {
    from: string;
    to: string;
    count: number;
}

/** Element kinds that become graph nodes. Everything else folds into the props of the nearest element. */
const NAMED = new Set([
    'Module', 'Role', 'Actor', 'Tenant', 'Enum', 'EnumLiteral', 'ValueType', 'Entity', 'Field', 'Event', 'Action',
    'Param', 'ErrorDecl', 'Machine', 'Job', 'Query', 'Projection', 'ProjectionField', 'External', 'ExternalOperation',
    'UseCase', 'Interface', 'Page', 'Navigation', 'Flow', 'Messages', 'Migration'
]);

/** The key of an unnamed element, derived from its content (concept.md section 4). Undefined for other nodes. */
function keyOf(node: AstNode): string | undefined {
    if (isInvariant(node)) return `invariant[${JSON.stringify(node.label)}]`;
    if (isPolicy(node)) {
        const fields = node.fields.length ? `fields ${node.fields.map(refText).join(',')}` : '';
        return `policy[${[node.operations.join(','), fields].filter(Boolean).join(' ')}]`;
    }
    if (isTransition(node)) return `transition[${node.from.join(',')}->${node.to}]`;
    if (isEndpoint(node)) return `endpoint[${node.verb} ${node.path}]`;
    if (isSetEffect(node)) return `effect[set ${refText(node.field)}]`;
    if (isCreateEffect(node)) return `effect[create ${refText(node.entity)}]`;
    if (isEmitEffect(node)) return `effect[emit ${refText(node.event)}]`;
    return undefined;
}

export function isElement(node: AstNode): boolean {
    return NAMED.has(node.$type) || keyOf(node) !== undefined;
}

/** Builds the graph of resolved models. Node and edge order follows the documents. */
export function buildGraph(models: Model[]): Graph {
    const nodes: GraphNode[] = [];
    const qns = new Map<AstNode, string>();
    const owners: [AstNode, string][] = [];

    const visit = (node: AstNode, parent: GraphNode | undefined, siblings: Map<string, number>): void => {
        const isModule = node.$type === 'Module';
        const local = localName(node, siblings);
        const qn = isModule ? modulePath(node as Module) : `${parent!.qn}.${local}`;
        const graphNode: GraphNode = {
            qn,
            kind: node.$type,
            layer: isModule ? 'cross' : parent!.kind === 'Module' ? LAYER_OF[node.$type] : parent!.layer,
            level: isModule || node.$type === 'UseCase' ? 'out' : parent!.kind === 'Module' ? 'medium' : 'in',
            module: isModule ? (parent?.qn ?? '') : parent!.kind === 'Module' ? parent!.qn : parent!.module,
            props: props(node)
        };
        nodes.push(graphNode);
        qns.set(node, qn);
        owners.push([node, qn]);
        const children = new Map<string, number>();
        for (const child of elementsBelow(node)) visit(child, graphNode, children);
    };
    for (const model of models) {
        for (const module of model.modules) visit(module, undefined, new Map());
    }

    const edges: GraphEdge[] = [];
    const seen = new Set<string>();
    const add = (edge: GraphEdge) => {
        const key = `${edge.from} ${edge.kind} ${edge.to}`;
        if (!seen.has(key)) {
            seen.add(key);
            edges.push(edge);
        }
    };
    for (const [node, qn] of owners) {
        for (const child of elementsBelow(node)) add({ from: qn, to: qns.get(child)!, kind: 'contains' });
        for (const ref of referencesOf(node)) {
            const referenced = AstUtils.getReferenceNodes(ref.reference)[0];
            const target = referenced && qns.get(referenced);
            if (target) add({ from: qn, to: target, kind: ref.property === 'decl' ? 'type' : ref.property });
        }
    }
    return { nodes, edges };
}

/** Module to module dependencies, aggregated from every edge that crosses a module boundary. */
export function dependencies(graph: Graph): Dependency[] {
    const moduleOf = new Map(graph.nodes.map(n => [n.qn, n.kind === 'Module' ? n.qn : n.module]));
    const counts = new Map<string, Dependency>();
    for (const edge of graph.edges.filter(e => e.kind !== 'contains')) {
        const from = moduleOf.get(edge.from)!;
        const to = moduleOf.get(edge.to)!;
        if (from === to) continue;
        const dependency = counts.get(`${from} ${to}`) ?? { from, to, count: 0 };
        dependency.count++;
        counts.set(`${from} ${to}`, dependency);
    }
    return [...counts.values()];
}

function localName(node: AstNode, siblings: Map<string, number>): string {
    if (NAMED.has(node.$type)) return (node as AstNode & { name: string }).name;
    const key = keyOf(node)!;
    const count = (siblings.get(key) ?? 0) + 1;
    siblings.set(key, count);
    return count === 1 ? key : `${key}#${count}`;
}

/** The nearest elements below a node, looking through non element nodes such as preconditions. */
function* elementsBelow(node: AstNode): Generator<AstNode> {
    for (const child of AstUtils.streamContents(node)) {
        if (isElement(child)) yield child;
        else yield* elementsBelow(child);
    }
}

/** References made by a node itself or by the non element nodes it contains. */
function* referencesOf(node: AstNode): Generator<ReferenceInfo> {
    yield* AstUtils.streamReferences(node);
    for (const child of AstUtils.streamContents(node)) {
        if (!isElement(child)) yield* referencesOf(child);
    }
}

/** Scalar properties as they are, contained non element nodes as canonical source text. References become edges. */
function props(node: AstNode): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
        if (key.startsWith('$') || key === 'name' || value === undefined || value === false) continue;
        const values = Array.isArray(value) ? value : [value];
        if (values.length === 0 || values.some(v => isReference(v) || (isAstNode(v) && isElement(v)))) continue;
        const shown = values.map(v => isAstNode(v) ? print(v).trim() : v);
        result[key] = Array.isArray(value) ? shown : shown[0];
    }
    return result;
}

function refText(ref: Reference): string {
    return ref.$refText;
}

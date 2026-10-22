import type { Dependency, Graph, GraphNode } from '@appling/model';
import type { Layout, Level } from '../../shared/snapshot.js';

export interface Row {
    qn: string;
    text: string;
}

export interface Card {
    qn: string;
    kind: string;
    layer: string;
    title: string;
    rows: Row[];
    /** The module group the card sits in, for the medium and in levels. */
    group?: string;
}

export interface Link {
    id: string;
    from: string;
    to: string;
    label: string;
}

export interface View {
    level: Level;
    groups: Card[];
    cards: Card[];
    links: Link[];
}

const KEYWORDS: Record<string, string> = {
    ValueType: 'value', UseCase: 'usecase', Machine: 'machine', External: 'external', Messages: 'messages'
};

export function levelForZoom(zoom: number): Level {
    return zoom < 0.5 ? 'out' : zoom < 1.05 ? 'medium' : 'in';
}

export class GraphIndex {
    readonly nodes: Map<string, GraphNode>;
    private readonly childrenOf = new Map<string, GraphNode[]>();
    private readonly parentOf = new Map<string, string>();

    constructor(readonly graph: Graph) {
        this.nodes = new Map(graph.nodes.map(n => [n.qn, n]));
        for (const edge of graph.edges.filter(e => e.kind === 'contains')) {
            this.childrenOf.set(edge.from, [...(this.childrenOf.get(edge.from) ?? []), this.nodes.get(edge.to)!]);
            this.parentOf.set(edge.to, edge.from);
        }
    }

    children(qn: string): GraphNode[] {
        return this.childrenOf.get(qn) ?? [];
    }

    parent(qn: string): string | undefined {
        return this.parentOf.get(qn);
    }

    /** The qualified name itself and its ancestors, innermost first. */
    lineage(qn: string): string[] {
        const result: string[] = [];
        for (let current: string | undefined = qn; current; current = this.parent(current)) result.push(current);
        return result;
    }
}

/** What the canvas shows at a zoom level: modules and use cases, declarations, or declarations with their members. */
export function view(index: GraphIndex, dependencies: Dependency[], level: Level): View {
    const modules = index.graph.nodes.filter(n => n.kind === 'Module');
    if (level === 'out') {
        return {
            level,
            groups: [],
            cards: modules.map(m => card(m, index.children(m.qn).filter(c => c.kind === 'UseCase'), m.qn)),
            links: dependencies.map(d => ({ id: `${d.from}>${d.to}`, from: d.from, to: d.to, label: `${d.count}` }))
        };
    }
    const declarations = index.graph.nodes.filter(n => n.kind !== 'Module' && index.nodes.get(index.parent(n.qn) ?? '')?.kind === 'Module');
    const cards = declarations.map(d => ({ ...card(d, level === 'in' ? index.children(d.qn) : [], `${KEYWORDS[d.kind] ?? d.kind.toLowerCase()} ${localName(d.qn, index)}`), group: index.parent(d.qn) }));
    const shown = new Set(cards.map(c => c.qn));
    const links = new Map<string, Link>();
    for (const edge of index.graph.edges.filter(e => e.kind !== 'contains')) {
        const from = index.lineage(edge.from).find(q => shown.has(q));
        const to = index.lineage(edge.to).find(q => shown.has(q));
        if (!from || !to || from === to) continue;
        const id = `${from}>${to}>${edge.kind}`;
        if (!links.has(id)) links.set(id, { id, from, to, label: edge.kind });
    }
    return {
        level,
        groups: modules.map(m => ({ ...card(m, [], m.qn), group: index.nodes.get(index.parent(m.qn) ?? '')?.kind === 'Module' ? index.parent(m.qn) : undefined })),
        cards,
        links: [...links.values()]
    };
}

/** The card or row that stands for a selected element at this level: the element itself or its nearest shown ancestor. */
export function shownFor(qn: string | undefined, current: View, index: GraphIndex): { card?: string, row?: string } {
    if (!qn) return {};
    const cards = new Set([...current.cards.map(c => c.qn), ...current.groups.map(g => g.qn)]);
    const lineage = index.lineage(qn);
    const card = lineage.find(q => cards.has(q));
    const rows = new Set(current.cards.find(c => c.qn === card)?.rows.map(r => r.qn));
    return { card, row: lineage.find(q => rows.has(q)) };
}

/** The innermost element whose source contains the offset. */
export function elementAt(locations: Record<string, { uri: string, start: number, end: number }>, uri: string, offset: number): string | undefined {
    let best: string | undefined;
    let size = Infinity;
    for (const [qn, l] of Object.entries(locations)) {
        if (l.uri === uri && l.start <= offset && offset <= l.end && l.end - l.start < size) {
            best = qn;
            size = l.end - l.start;
        }
    }
    return best;
}

function card(node: GraphNode, members: GraphNode[], title: string): Card {
    return { qn: node.qn, kind: node.kind, layer: node.layer, title, rows: members.map(m => ({ qn: m.qn, text: rowText(m, node.qn) })) };
}

function rowText(node: GraphNode, parent: string): string {
    const name = node.qn.slice(parent.length + 1);
    const type = typeof node.props.type === 'string' ? `: ${node.props.type}` : '';
    const modifiers = Array.isArray(node.props.modifiers) ? ` ${node.props.modifiers.join(' ')}` : '';
    return `${name}${type}${modifiers}`;
}

function localName(qn: string, index: GraphIndex): string {
    return qn.slice((index.parent(qn)?.length ?? -1) + 1);
}

/** Moves saved positions along the renames recorded in migration steps, so layout follows renamed elements. */
export function followRenames(layout: Layout, graph: Graph): Layout {
    const renames = graph.nodes.filter(n => n.kind === 'Migration').flatMap(m => ((m.data.steps ?? []) as { $type: string, target: string, newName?: string }[])
        .filter(s => s.$type === 'RenameStep')
        .map(s => [`${m.module}.${s.target}`, `${m.module}.${s.target.replace(/[^.]+$/, s.newName!)}`] as [string, string]));
    return moveLayout(layout, renames);
}

/** Moves the saved positions of renamed elements and everything inside them to their new names. */
export function moveLayout(layout: Layout, renames: [string, string][]): Layout {
    const positions = Object.fromEntries(Object.entries(layout.positions ?? {}).map(([level, saved]) => {
        const moved = { ...saved };
        for (const [from, to] of renames) {
            for (const qn of Object.keys(moved).filter(q => q === from || q.startsWith(`${from}.`))) {
                moved[to + qn.slice(from.length)] ??= moved[qn];
                delete moved[qn];
            }
        }
        return [level, moved];
    }));
    return { ...layout, positions };
}

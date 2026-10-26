import type { Flow, FlowEdge, FlowNode, TreeNode } from './views.js';

/** A node of the tree at its place: the seed at 0,0, children above their parent. */
export interface Placed {
    node: TreeNode;
    x: number;
    y: number;
    parent?: Placed;
}

/** The width each node type takes in a row: a circle with its labels on the right. */
const SLOT: Record<TreeNode['type'], number> = { seed: 220, module: 260, group: 210, element: 250 };
/** From a parent to the first row of its children. */
const LEVEL = 140;
/** Between the rows of a wrapped group. */
const ROW = 100;
/** Folded children beyond this many wrap into rows. */
const WRAP = 6;

/**
 * Places the tree growing upwards: each parent centered below its children, groups of folded elements wrapped into
 * rows. Children come most relevant first; each row puts them in the middle and the least relevant at the edges.
 */
export function layoutTree(root: TreeNode): Placed[] {
    const placed: Placed[] = [];
    const place = (node: TreeNode, x: number, y: number, parent?: Placed) => {
        const here = { node, x, y, parent };
        placed.push(here);
        const children = node.children ?? [];
        if (wraps(node)) {
            const slot = SLOT[children[0].type];
            for (let row = 0; row * WRAP < children.length; row++) {
                const inRow = centered(children.slice(row * WRAP, (row + 1) * WRAP));
                inRow.forEach((child, column) => place(child, x + (column - (inRow.length - 1) / 2) * slot, y - LEVEL - row * ROW, here));
            }
            return;
        }
        let left = x - children.reduce((sum, child) => sum + width(child), 0) / 2;
        for (const child of centered(children)) {
            place(child, left + width(child) / 2, y - LEVEL, here);
            left += width(child);
        }
    };
    place(root, 0, 0);
    return placed;
}

/** The first in the middle, then the next ones alternating to either side. */
function centered<T>(items: T[]): T[] {
    const result: T[] = [];
    items.forEach((item, i) => i % 2 ? result.unshift(item) : result.push(item));
    return result;
}

function wraps(node: TreeNode): boolean {
    return (node.children?.length ?? 0) > WRAP && !node.children!.some(c => c.children);
}

function width(node: TreeNode): number {
    const children = node.children ?? [];
    if (!children.length) return SLOT[node.type];
    if (wraps(node)) return Math.max(SLOT[node.type], WRAP * SLOT[children[0].type]);
    return Math.max(SLOT[node.type], children.reduce((sum, child) => sum + width(child), 0));
}

export interface PlacedFlow {
    width: number;
    height: number;
    /** Centered on `x`, `y`. */
    nodes: { node: FlowNode, x: number, y: number, width: number, height: number }[];
    /** The label centered on `x`, `y`. */
    edges: { edge: FlowEdge, path: string, x: number, y: number }[];
}

/** The width of one character of the flowchart's 12px monospace labels. */
const CHAR = 7.3;
/** Between two nodes of a rank, and from one rank to the next. */
const GAP = 56;
const RANK = 110;
const MARGIN = 24;

/**
 * Places a flowchart top down: each node one rank below the first node that leads to it, the starts on top. Edges run
 * in straight segments with right angle corners: one downwards leaves the bottom of its node and turns in the gap below
 * it; one back up, within its rank or to its own node leaves and enters on the right, beyond both nodes.
 */
export function layoutFlow(flow: Flow): PlacedFlow {
    const rank = new Map<string, number>();
    const rows: string[][] = [];
    const visit = (id: string, at: number) => {
        if (rank.has(id)) return;
        rank.set(id, at);
        (rows[at] ??= []).push(id);
        for (const edge of flow.edges.filter(e => e.from === id)) visit(edge.to, at + 1);
    };
    const leads = (id: string) => flow.edges.some(e => e.to === id && e.from !== id);
    [...flow.nodes.filter(n => !leads(n.id)), ...flow.nodes].forEach(n => visit(n.id, 0));
    const x = new Map<string, number>();
    const size = new Map(flow.nodes.map(n => [n.id, { width: textWidth(n, 32), height: n.note ? 46 : 32 }]));
    rows.forEach((row, r) => {
        const below = (id: string) => flow.edges.filter(e => e.to === id && rank.get(e.from)! < r).map(e => x.get(e.from)!);
        const order = r ? [...row].sort((a, b) => mean(below(a)) - mean(below(b))) : row;
        let left = -(order.reduce((sum, id) => sum + size.get(id)!.width, 0) + GAP * (order.length - 1)) / 2;
        for (const id of order) {
            x.set(id, left + size.get(id)!.width / 2);
            left += size.get(id)!.width + GAP;
        }
    });
    const nodes = flow.nodes.map(node => ({ node, x: x.get(node.id)!, y: rank.get(node.id)! * RANK, ...size.get(node.id)! }));
    const at = new Map(nodes.map(n => [n.node.id, n]));
    const parallel = new Map<string, number>();
    const edges = flow.edges.map(edge => {
        const [from, to] = [at.get(edge.from)!, at.get(edge.to)!];
        const key = `${edge.from} ${edge.to}`;
        const k = parallel.get(key) ?? 0;
        parallel.set(key, k + 1);
        const points: [number, number][] = to.y > from.y
            ? [[from.x, from.y + from.height / 2], [from.x, from.y + RANK / 2], [to.x, from.y + RANK / 2], [to.x, to.y - to.height / 2]]
            : aside(from, to, k);
        // On the segment no other edge shares: into the target downwards, the outer one aside.
        const [[x1, y1], [x2, y2]] = to.y > from.y ? points.slice(2) : points.slice(1, 3);
        return { edge, points, x: (x1 + x2) / 2, y: (y1 + y2) / 2 + k * 16 };
    });
    const xs = [
        ...nodes.flatMap(n => [n.x - n.width / 2, n.x + n.width / 2]),
        ...edges.flatMap(e => [e.x - textWidth(e.edge, 12) / 2, e.x + textWidth(e.edge, 12) / 2, ...e.points.map(([px]) => px)])
    ];
    const [left, right] = [Math.min(...xs) - MARGIN, Math.max(...xs) + MARGIN];
    const [top, bottom] = [-RANK / 2, (rows.length - 1) * RANK + RANK / 2];
    return {
        width: right - left, height: bottom - top,
        nodes: nodes.map(n => ({ ...n, x: n.x - left, y: n.y - top })),
        edges: edges.map(({ edge, points, x, y }) => {
            return { edge, path: `M ${points.map(([px, py]) => `${px - left} ${py - top}`).join(' L ')}`, x: x - left, y: y - top };
        })
    };
}

type Box = { x: number, y: number, width: number, height: number };

/** From the right side of one node to the right side of another, out beyond both; a loop to its own node enters below where it leaves. */
function aside(from: Box, to: Box, k: number): [number, number][] {
    const [start, end] = [from.x + from.width / 2, to.x + to.width / 2];
    const out = Math.max(start, end) + (from === to ? 28 : 56) + k * 24;
    const [y1, y2] = from === to ? [from.y - 6, from.y + 6] : [from.y, to.y];
    return [[start, y1], [out, y1], [out, y2], [end, y2]];
}

function mean(values: number[]): number {
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function textWidth({ label = '', note = '' }: { label?: string, note?: string }, padding: number): number {
    return Math.max(label.length, note.length * 0.9) * CHAR + padding;
}

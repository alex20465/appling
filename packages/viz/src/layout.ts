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
/** Children beyond this many wrap into rows. */
const WRAP = 4;

/** The children of one node as they stand together: a row, or the rows of a wrapped group. */
interface Block {
    parent: Placed;
    /** Each child, from the middle of the block and at its height. */
    items: { node: TreeNode, dx: number, y: number }[];
    /** What each row takes, from the middle of the block. */
    rows: Row[];
}

interface Row { left: number, right: number, y: number }

/** What one row higher costs, in the width a block would otherwise lean to its side. */
const LIFT = 2;
/** Beside its parent's place, a block's stems run between the nodes of the rows above. */
const BETWEEN = SLOT.element / 2;
/** What a stem through another node costs: only where nothing else is free. */
const CROSSING = 1000;

/**
 * Places the tree growing upwards the way a plant does: each node's children go above it, most relevant in the middle,
 * many children wrapped into rows about as many as they are wide. What stands stays: the nodes unfold in the order
 * they were `opened` (the others after them, the nearest to the seed first), and the children of each take the
 * nearest room that is left. Where they would meet rows that stand, they give way a little to their side, or grow on a
 * longer stem above them once that is nearer, so a tree of many crowns grows in height as well as in width.
 */
export function layoutTree(root: TreeNode, opened: Iterable<string> = []): Placed[] {
    const placed: Placed[] = [{ node: root, x: 0, y: 0 }];
    const rows: Row[] = [];
    const turn = new Map([...opened].map((id, i) => [id, i]));
    const turnOf = (p: Placed) => turn.get(p.node.id) ?? Infinity;
    const waiting = [...placed];
    while (waiting.length) {
        const parent = waiting.reduce((first, p) => turnOf(p) < turnOf(first) ? p : first);
        waiting.splice(waiting.indexOf(parent), 1);
        if (!parent.node.children?.length) continue;
        const block = blockOf(parent);
        const { x, lift } = roomFor(block, rows, placed);
        const items = block.items.map(item => ({ node: item.node, x: x + item.dx, y: item.y - lift, parent }));
        rows.push(...block.rows.map(r => ({ left: x + r.left, right: x + r.right, y: r.y - lift })));
        placed.push(...items);
        waiting.push(...items);
    }
    return placed;
}

/** Where a block is nearest to its place above its parent without meeting a row that stands, its stems past the nodes between. */
function roomFor(block: Block, rows: Row[], placed: Placed[]): { x: number, lift: number } {
    const home = block.parent.x;
    let best = { x: home, lift: 0, cost: Infinity };
    for (let lift = 0; lift * LIFT < best.cost; lift += ROW) {
        const taken = block.rows.flatMap(r => rows.filter(o => meet(o.y, r.y - lift)).map(o => [o.left - r.right, o.right - r.left]));
        const between = placed.filter(p => p.y < block.parent.y && p.y > block.rows.at(-1)!.y - lift);
        const crossing = (x: number) => block.items.some(item => between.some(p => p.y > item.y - lift && crosses(block.parent, x + item.dx, item.y - lift, p)));
        const free = [home, home - BETWEEN, home + BETWEEN, ...taken.flat()].filter(x => !taken.some(([from, to]) => x > from && x < to)).sort((a, b) => Math.abs(a - home) - Math.abs(b - home));
        for (const x of free.slice(0, 6)) {
            const cost = Math.abs(x - home) + lift * LIFT + (crossing(x) ? CROSSING : 0);
            if (cost < best.cost) best = { x, lift, cost };
        }
    }
    return best;
}

/** The stem from a node to a child at this place runs through another node: the curve of `stem` in `canvas/plant.ts`. */
function crosses(from: Placed, x: number, y: number, node: Placed): boolean {
    for (let t = 0.05; t < 1; t += 0.05) {
        const u = 1 - t;
        const sx = u ** 3 * from.x + 3 * u * u * t * (from.x + (x - from.x) * 0.35) + (3 * u * t * t + t ** 3) * x;
        const sy = from.y + (y - from.y) * (3 * u * u * t * 0.45 + 3 * u * t * t * 0.5 + t ** 3);
        if (Math.abs(sx - node.x) < 50 && Math.abs(sy - node.y) < 50) return true;
    }
    return false;
}

function blockOf(parent: Placed): Block {
    const lines = linesOf(parent.node.children!);
    const block: Block = { parent, items: [], rows: [] };
    lines.forEach((line, i) => {
        const y = parent.y - LEVEL - i * ROW;
        const width = line.reduce((sum, child) => sum + SLOT[child.type], 0);
        let left = -width / 2;
        for (const node of centered(line)) {
            block.items.push({ node, dx: left + SLOT[node.type] / 2, y });
            left += SLOT[node.type];
        }
        block.rows.push({ left: -width / 2, right: width / 2, y });
    });
    return block;
}

/** Two rows at these heights are near enough for their nodes to touch. */
function meet(y1: number, y2: number): boolean {
    return Math.abs(y1 - y2) < ROW;
}

/** The first in the middle, then the next ones alternating to either side. */
function centered<T>(items: T[]): T[] {
    const result: T[] = [];
    items.forEach((item, i) => i % 2 ? result.unshift(item) : result.push(item));
    return result;
}

function linesOf(children: TreeNode[]): TreeNode[][] {
    if (children.length <= WRAP) return [children];
    const columns = Math.ceil(Math.sqrt(children.length));
    return Array.from({ length: Math.ceil(children.length / columns) }, (_, i) => children.slice(i * columns, (i + 1) * columns));
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

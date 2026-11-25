import type { DiagramElement, Flow, FlowEdge, FlowNode, TreeNode, UseCaseDiagram } from './views.js';

export type Point = [number, number];

/** A node of the pyramid at its place: the band of the entry level at 0, every higher level above it. */
export interface Placed {
    node: TreeNode;
    x: number;
    y: number;
    /** How wide a module's frame is around its declarations. */
    width: number;
    parent?: Placed;
    /** The corners of the trace from the declaration it unfolded from. */
    route?: Point[];
    /** The traces to what its unfolded sides also lead to and is drawn elsewhere already (`TreeNode.links`), by the id of that node. */
    joins?: { to: string, points: Point[] }[];
    /** On the seed: the five bands. */
    bands?: Band[];
}

/** The width each node takes in its band, with the chip the canvas draws around its middle. */
const SLOT = 256;
/** A band of one row, with half a channel above and below. */
export const ROW = 120;
/** What a module's frame leaves free around its declarations, half on each side. */
export const FRAME = 48;
/** A chip as the canvas draws it around the place of an element: half its width and half its height. */
const WIDE = 116;
const HALF = 26;
/** Between two traces that run side by side, and between two that end on the same edge of a chip. */
const TRACK = 8;
const PIN = 10;
/** From a row of chips to the first trace along it, and the least between two rows of one band. */
const PAD = 20;
const WITHIN = 28;
/** How far out of its way a trace goes to cross one less. */
const CROSSING = 200;

/** One band of the pyramid: the middle of its first row, the one nearest to the entry level, and how far it reaches. */
export interface Band {
    level: number;
    y: number;
    top: number;
    bottom: number;
}

/** The bands of a placed pyramid, for what the canvas draws behind and beside it. */
export function bandsOf(placed: Placed[]): Band[] {
    return placed.find(p => p.bands)!.bands!;
}

/**
 * Places the pyramid in bands, one per level, the higher level above: a module is a frame in the band of the entry
 * level around its declarations, and every declaration owns the strip above and below it, as wide as all that unfolds
 * from it on its wider side. What unfolds stands in the band of its own level, however many bands away, in a fixed
 * order: one or two side by side, each in the middle of its strip, more wrapped into a grid, so a band grows by rows.
 * A declaration never leaves its place in the grid: what it unfolds stands in a strip beside the grid, in the order
 * of the grid. Unfolding moves the others aside, never past one another. The traces between them are routed last
 * (`route`); the rows stand as far apart as their traces need.
 */
export function layoutTree(root: TreeNode, entry: number): Placed[] {
    const widths = new Map<TreeNode, number>();
    const sum = (nodes: TreeNode[], width: (node: TreeNode) => number) => nodes.reduce((all, child) => all + width(child), 0);
    const on = (node: TreeNode, side?: Side) => (node.children ?? []).filter(child => child.side === side);
    /** One side of a declaration, level by level, each level in so many columns. */
    const groups = (node: TreeNode, side: Side) => [...Map.groupBy(on(node, side), child => child.level!).values()]
        .map(nodes => ({ nodes, columns: nodes.length <= 2 ? nodes.length : Math.ceil(Math.sqrt(nodes.length)) }));
    const beyond = (node: TreeNode) => Math.max(sideWidth(node, 'up'), sideWidth(node, 'down'));
    const groupWidth = ({ nodes, columns }: { nodes: TreeNode[], columns: number }) => columns === nodes.length ? sum(nodes, widthOf) : columns * SLOT + sum(nodes, beyond);
    const sideWidth = (node: TreeNode, side: Side): number => groups(node, side).reduce((all, group) => all + groupWidth(group), 0);
    const widthOf = (node: TreeNode): number => {
        if (!widths.has(node)) widths.set(node, Math.max(SLOT, sum(on(node), widthOf), beyond(node)) + (node.type === 'module' ? FRAME : 0));
        return widths.get(node)!;
    };
    const placed: Placed[] = [];
    /** The row of a declaration within its band, 0 the one nearest to the entry level. */
    const rows = new Map<Placed, number>();
    /** What unfolds from a placed declaration, in the strip from `left`. */
    const unfold = (here: Placed, left: number, width: number) => {
        const node = here.node;
        for (const side of SIDES) {
            let at = left + (width - sideWidth(node, side)) / 2;
            for (const group of groups(node, side)) {
                const { nodes, columns } = group;
                let strip = at + columns * SLOT;
                nodes.forEach((child, i) => {
                    if (columns === nodes.length) {
                        const there: Placed = { node: child, x: at + widthOf(child) / 2, y: 0, width: SLOT, parent: here };
                        placed.push(there);
                        unfold(there, at, widthOf(child));
                        at += widthOf(child);
                        return;
                    }
                    const there: Placed = { node: child, x: at + i % columns * SLOT + SLOT / 2, y: 0, width: SLOT, parent: here };
                    placed.push(there);
                    rows.set(there, Math.floor(i / columns));
                    unfold(there, strip, beyond(child));
                    strip += beyond(child);
                });
                if (columns !== nodes.length) at += groupWidth(group);
            }
        }
    };
    const place = (node: TreeNode, left: number, parent?: Placed) => {
        const width = widthOf(node);
        const here: Placed = { node, x: left + width / 2, y: 0, width, parent };
        placed.push(here);
        if (node.type === 'element') return unfold(here, left, width);
        let at = left + (width - sum(on(node), widthOf)) / 2;
        for (const child of on(node)) {
            place(child, at, here);
            at += widthOf(child);
        }
    };
    place(root, -widthOf(root) / 2);
    placed[0].bands = route(placed.filter(p => p.node.type === 'element'), p => rows.get(p) ?? 0, entry);
    return placed;
}

type Side = NonNullable<TreeNode['side']>;
const SIDES: Side[] = ['up', 'down'];

interface Edge { from: Placed, to: Placed, join: boolean }
/** One net in one channel: where it comes in on the side of its start (`near`), where it leaves on the other side, to chips and through their row (`riser`). */
interface Stretch { row: number, channel: number, near: number, riser?: number, lo: number, hi: number, tops: number[], bottoms: number[], y: number }

/**
 * Routes the traces of a pyramid like those of a circuit board and gives every row its height. All that a
 * declaration leads to on one side is one net: it leaves the middle of that edge of its chip, and in the channel
 * before each row with one of its ends it runs along a track of its own, from which it ends in the chips of that row,
 * each end at a place of its own on the chip's edge, and passes the row through a gap between two chips. So no two
 * nets ever share a stretch; they cross at right angles only, and the tracks of a channel are ordered so that as few
 * cross as its ends allow. A channel is as high as its tracks need.
 */
function route(chips: Placed[], rowIn: (chip: Placed) => number, entry: number): Band[] {
    const lines: { level: number, chips: Placed[] }[] = [];
    for (const level of [5, 4, 3, 2, 1]) {
        const own = chips.filter(p => p.node.level === level);
        const depth = 1 + Math.max(0, ...own.map(rowIn));
        for (let i = 0; i < depth; i++) lines.push({ level, chips: own.filter(p => rowIn(p) === (level > entry ? depth - 1 - i : i)).sort((a, b) => a.x - b.x) });
    }
    const at = new Map(lines.flatMap((line, row) => line.chips.map(chip => [chip, row] as const)));
    const drawn = new Map(chips.map(p => [p.node.qn!, p]));
    const edges: Edge[] = [
        ...chips.filter(p => p.parent?.node.type === 'element').map(p => ({ from: p.parent!, to: p, join: false })),
        ...chips.flatMap(p => (p.node.links ?? []).flatMap(qn => drawn.has(qn) ? [{ from: p, to: drawn.get(qn)!, join: true }] : []))
    ].filter(e => at.get(e.from) !== at.get(e.to));
    const towards = (e: Edge) => Math.sign(at.get(e.to)! - at.get(e.from)!);
    const pins = new Map<Edge, number>();
    for (const into of Map.groupBy(edges, e => `${e.to.node.id} ${towards(e)}`).values()) {
        const pitch = Math.min(PIN, (2 * WIDE - 40) / into.length);
        into.sort((a, b) => a.from.x - b.from.x).forEach((e, i) => pins.set(e, e.to.x + (i - (into.length - 1) / 2) * pitch));
    }
    /** One net through its channels, past each row where it is nearest to `want`, or else on the shortest way. Channel `i` lies above row `i`. */
    const run = (net: Edge[], others: Stretch[], want?: number): Stretch[] => {
        const d = towards(net[0]);
        const ends = net.map(e => at.get(e.to)!);
        const last = d < 0 ? Math.min(...ends) : Math.max(...ends);
        let x = net[0].from.x;
        const stretches: Stretch[] = [];
        for (let row = at.get(net[0].from)! + d; row !== last + d; row += d) {
            const here = net.filter(e => at.get(e.to) === row).map(e => pins.get(e)!);
            const further = net.filter(e => (at.get(e.to)! - row) * d > 0).map(e => pins.get(e)!);
            const taken = others.flatMap(s => s.row === row && s.riser !== undefined ? [s.riser] : []);
            const riser = further.length ? gap(lines[row].chips, taken, want ?? x, want ?? Math.max(Math.min(...further), Math.min(x, Math.max(...further)))) : undefined;
            const far = riser === undefined ? here : [...here, riser];
            stretches.push({ row, channel: Math.max(row, row - d), near: x, riser, lo: Math.min(x, ...far), hi: Math.max(x, ...far), tops: d < 0 ? far : [x], bottoms: d < 0 ? [x] : far, y: 0 });
            x = riser ?? x;
        }
        return stretches;
    };
    /** What a net costs beside the others: the crossings no order of the tracks avoids, then its length. */
    const weigh = (stretches: Stretch[], others: Stretch[]) => stretches.reduce((all, s) => all + s.hi - s.lo
        + others.filter(o => o.channel === s.channel).reduce((sum, o) => sum + CROSSING * Math.min(cost(s, o), cost(o, s)), 0), 0);
    const nets = [...Map.groupBy(edges, e => `${e.from.node.id} ${towards(e)}`).values()].sort((a, b) => b.length - a.length).map(net => ({ net, d: towards(net[0]), stretches: [] as Stretch[] }));
    // every net in turn on the way that costs the least beside the others, twice over so the first ones meet the last
    for (let turn = 0; turn < 3; turn++) for (const one of nets) {
        const others = nets.flatMap(n => n === one ? [] : n.stretches);
        const passed = new Set(run(one.net, others).map(s => s.row));
        const wants = new Set([undefined, one.net[0].from.x, ...one.net.map(e => pins.get(e)!), ...lines.flatMap((line, row) => passed.has(row) ? line.chips.flatMap(c => [c.x - WIDE - TRACK, c.x + WIDE + TRACK]) : [])]);
        one.stretches = [...wants].map(want => run(one.net, others, want)).reduce((a, b) => weigh(b, others) < weigh(a, others) ? b : a);
    }
    const channels: Stretch[][] = lines.map((_, i) => nets.flatMap(n => n.stretches.filter(s => s.channel === i)));

    // the tracks of every channel, and with them how far its two rows stand apart
    const ys = [0];
    for (let row = 1; row < lines.length; row++) {
        const tracks = ordered(channels[row].filter(s => s.hi > s.lo));
        const height = Math.max(lines[row].level === lines[row - 1].level ? WITHIN : ROW - 2 * HALF, 2 * PAD + (tracks.length - 1) * TRACK);
        const top = ys[row - 1] + HALF;
        tracks.forEach((track, i) => track.forEach(s => s.y = top + (height - (tracks.length - 1) * TRACK) / 2 + i * TRACK));
        for (const s of channels[row]) if (s.hi === s.lo) s.y = top + height / 2;
        ys.push(top + height + HALF);
    }
    const zero = ys[lines.findIndex(line => line.level === entry)];
    for (const [chip, row] of at) chip.y = ys[row] - zero;
    for (const s of channels.flat()) s.y -= zero;

    for (const chip of chips) [chip.route, chip.joins] = [undefined, undefined];
    for (const { net, d, stretches } of nets) {
        for (const e of net) {
            const points: Point[] = [[e.from.x, e.from.y + d * HALF]];
            for (const s of stretches) {
                const ends = s.row === at.get(e.to);
                points.push([s.near, s.y], [ends ? pins.get(e)! : s.riser!, s.y]);
                if (ends) break;
            }
            points.push([pins.get(e)!, e.to.y - d * HALF]);
            if (e.join) (e.from.joins ??= []).push({ to: e.to.node.id, points });
            else e.to.route = points;
        }
    }

    return [1, 2, 3, 4, 5].map(level => {
        const [first, last] = [lines.findIndex(line => line.level === level), lines.findLastIndex(line => line.level === level)];
        const between = (row: number) => (ys[row - 1] + ys[row]) / 2 - zero;
        return { level, y: ys[level > entry ? last : first] - zero, top: first ? between(first) : ys[0] - zero - ROW / 2, bottom: last < lines.length - 1 ? between(last + 1) : ys[last] - zero + ROW / 2 };
    });
}

/**
 * Where a net passes a row: in a gap between two of its chips or beside them, at the free place that takes it the
 * least out of its way from `x` towards `goal`, apart from the nets that pass there already.
 */
function gap(chips: Placed[], taken: number[], x: number, goal: number): number {
    const edges = [-Infinity, ...chips.flatMap(c => [c.x - WIDE - TRACK, c.x + WIDE + TRACK]), Infinity];
    const free = (at: number) => taken.every(t => Math.abs(t - at) >= TRACK);
    const found: number[] = [];
    for (let i = 0; i < edges.length; i += 2) {
        const [lo, hi] = [edges[i], edges[i + 1]];
        for (const want of [x, goal, lo, hi].filter(Number.isFinite)) {
            const start = Math.max(lo, Math.min(hi, want));
            for (let k = 0; start + k * TRACK <= hi || start - k * TRACK >= lo; k++) {
                const at = [start + k * TRACK, start - k * TRACK].find(c => c >= lo && c <= hi && free(c));
                if (at === undefined) continue;
                found.push(at);
                break;
            }
        }
    }
    return found.sort((a, b) => Math.abs(a - x) + Math.abs(a - goal) - Math.abs(b - x) - Math.abs(b - goal))[0];
}

/**
 * What one stretch above another in a channel costs: every end it has below within the other's reach and every end
 * the other has above within its own cross, and far more when such two ends would run into each other.
 */
function cost(above: Stretch, below: Stretch): number {
    const within = (xs: number[], s: Stretch) => xs.filter(x => x > s.lo && x < s.hi).length;
    return within(above.bottoms, below) + within(below.tops, above) + (above.bottoms.some(a => below.tops.some(b => Math.abs(a - b) < TRACK - 2)) ? 1000 : 0);
}

/** The stretches of one channel on their tracks from top to bottom, ordered so that as few as possible cross. Stretches that stay apart share a track. */
function ordered(stretches: Stretch[]): Stretch[][] {
    const total = (order: Stretch[]) => order.reduce((all, above, i) => all + order.slice(i + 1).reduce((sum, below) => sum + cost(above, below), 0), 0);
    let order = [...stretches].sort((a, b) => a.lo - b.lo || a.hi - b.hi);
    // each one moved to where it costs the least, until none moves
    for (let turn = 0, moved = true; moved && turn < 8; turn++) {
        moved = false;
        for (const s of [...order]) {
            const rest = order.filter(o => o !== s);
            const tries = rest.map((_, i) => [...rest.slice(0, i), s, ...rest.slice(i)]).concat([[...rest, s]]);
            const best = tries.reduce((a, b) => total(b) < total(a) ? b : a, order);
            moved ||= best !== order;
            order = best;
        }
    }
    const tracks: Stretch[][] = [];
    for (const s of order) {
        if (tracks.at(-1)?.every(t => s.lo > t.hi + 2 * TRACK || t.lo > s.hi + 2 * TRACK)) tracks.at(-1)!.push(s);
        else tracks.push([s]);
    }
    return tracks;
}

export interface PlacedFlow {
    width: number;
    height: number;
    /** Centered on `x`, `y`. */
    nodes: { node: FlowNode, x: number, y: number, width: number, height: number }[];
    /** The label at `x`, `y`: centered, or beside its edge starting or ending there. */
    edges: { edge: FlowEdge, path: string, x: number, y: number, anchor?: 'start' | 'end' }[];
    /** The initial pseudostate of a state diagram, and where its arrow ends. */
    initial?: { x: number, y: number, to: Point };
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

/** A chip of the use case diagram: its centre and half its width and height, as the chips of the level canvas. */
export interface UseCaseChip extends DiagramElement {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface PlacedUseCases {
    width: number;
    height: number;
    /** The system boundary around the use cases. */
    boundary: Box;
    actors: UseCaseChip[];
    useCases: (UseCaseChip & { subfunction?: boolean })[];
    /** A curve from the right edge of the actor to the left edge of the use case. */
    associations: { actor: string, useCase: string, from: Point, to: Point, path: string }[];
    /** The arrow as an SVG path, and the middle of it, where its label stands. */
    includes: { from: string, to: string, path: string, label: Point }[];
}

const GOAL_ROW = 100;
const SUB_ROW = 72;
const CASE_GAP = 150;
const CHIP_HALF = 26;
/** Room for the cell with the icon and the padding around the name, as on the level canvas. */
const CHIP_PAD = 48 + 30;

/** Half the width of a chip that fits the longest of the labels. */
function chipHalf(labels: string[], least: number): number {
    return Math.max(least, ...labels.map(l => (l.length * 7.6 + CHIP_PAD) / 2));
}

/** A curve that leaves and enters horizontally. */
function sCurve([x1, y1]: Point, [x2, y2]: Point): string {
    const mx = (x1 + x2) / 2;
    return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
}

/**
 * Places a use case diagram: the use cases in a column inside the system boundary, an included one right below the
 * one that includes it, the subfunctions in a column to the right beside the use cases that include them, and each
 * actor left of the boundary beside the use cases it starts, so no line runs through another chip.
 */
export function layoutUseCases(diagram: UseCaseDiagram): PlacedUseCases {
    const goals = diagram.useCases.filter(u => !u.subfunction);
    const subs = diagram.useCases.filter(u => u.subfunction);
    const order: typeof goals = [];
    const visit = (u: typeof goals[number]) => {
        if (order.includes(u)) return;
        order.push(u);
        diagram.includes.filter(i => i.from === u.qn).forEach(i => { const to = goals.find(g => g.qn === i.to); if (to) visit(to); });
    };
    [...goals.filter(g => !diagram.includes.some(i => i.to === g.qn)), ...goals].forEach(visit);
    const [actorW, goalW, subW] = [chipHalf(diagram.actors.map(a => a.label), 90), chipHalf(goals.map(g => g.label), 110), chipHalf(subs.map(u => u.label), 90)];
    const actorX = MARGIN + actorW;
    const left = actorX + actorW + 80;
    const goalX = left + 40 + goalW;
    const top = MARGIN + 24 + 40 + CHIP_HALF;
    const placedGoals = order.map((g, row) => ({ ...g, x: goalX, y: top + row * GOAL_ROW, w: goalW, h: CHIP_HALF }));
    const yOf = new Map(placedGoals.map(g => [g.qn, g.y]));
    const subX = goalX + goalW + CASE_GAP + subW;
    const placedSubs = spread(subs.map(u => ({ ...u, y: mean(diagram.includes.filter(i => i.to === u.qn).map(i => yOf.get(i.from) ?? top)) })), SUB_ROW, top)
        .map(u => ({ ...u, x: subX, w: subW, h: CHIP_HALF }));
    const useCases = [...placedGoals, ...placedSubs];
    const at = new Map(useCases.map(u => [u.qn, u]));
    const includes = diagram.includes.map(i => {
        const [from, to] = [at.get(i.from)!, at.get(i.to)!];
        if (from.x !== to.x) {
            const [start, end]: Point[] = [[from.x + from.w, from.y], [to.x - to.w, to.y]];
            return { ...i, path: sCurve(start, end), label: [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2] as Point };
        }
        // within the column: out of the right edge and back into it, the label on the middle of the curve
        const [x, out] = [from.x + from.w, from.x + from.w + 64];
        const [y1, y2] = [from.y + 10, to.y - 10];
        return { ...i, path: `M ${x} ${y1} C ${out} ${y1}, ${out} ${y2}, ${x} ${y2}`, label: [x + 48, (y1 + y2) / 2] as Point };
    });
    const bottom = Math.max(top, ...useCases.map(u => u.y + u.h)) + 40;
    const right = Math.max(subs.length ? subX + subW : goalX + goalW, ...includes.map(i => i.label[0] + 40)) + 40;
    const boundary = { x: left, y: MARGIN + 24, width: right - left, height: bottom - MARGIN - 24 };
    const started = (actor: string) => diagram.associations.filter(a => a.actor === actor).map(a => yOf.get(a.useCase)!).filter(y => y !== undefined);
    const actors = spread(diagram.actors.map(a => ({ ...a, y: started(a.qn).length ? mean(started(a.qn)) : bottom })), GOAL_ROW, top)
        .map(a => ({ ...a, x: actorX, w: actorW, h: CHIP_HALF }));
    return {
        width: right + MARGIN,
        height: Math.max(bottom, ...actors.map(a => a.y + a.h)) + MARGIN, boundary, actors, useCases,
        associations: diagram.associations.map(a => {
            const [actor, useCase] = [actors.find(x => x.qn === a.actor)!, at.get(a.useCase)!];
            const [from, to]: Point[] = [[actor.x + actor.w, actor.y], [useCase.x - useCase.w, useCase.y]];
            return { ...a, from, to, path: sCurve(from, to) };
        }),
        includes
    };
}

/** Keeps the wished `y` of each item in order, pushing items down until they stand `gap` apart. */
function spread<T extends { y: number }>(items: T[], gap: number, top: number): T[] {
    let last = top - gap;
    return [...items].sort((a, b) => a.y - b.y).map(item => {
        last = Math.max(item.y, last + gap);
        return { ...item, y: last };
    });
}

const STATE_RANK = 190;
const STATE_GAP = 200;
const STATE_HEIGHT = 48;

/**
 * Places a state diagram: each state one rank below the first state that leads to it, the initial state on top with
 * the initial pseudostate above it. A transition is a curve from border to border; transitions between the same two
 * states bend apart, and one whose straight line would cross another state bends around it.
 */
export function layoutStates(flow: Flow): PlacedFlow {
    const rank = new Map<string, number>();
    const rows: string[][] = [];
    const initial = flow.nodes.find(n => n.tag === 'initial');
    const queue = [initial ?? flow.nodes[0]].filter(n => n).map(n => n!.id);
    const enqueue = (id: string, at: number) => { if (!rank.has(id)) { rank.set(id, at); (rows[at] ??= []).push(id); queue.push(id); } };
    if (queue[0]) { rank.set(queue[0], 0); rows[0] = [queue[0]]; }
    for (let head = 0; head < flow.nodes.length * 2; head++) {
        const id = queue[head] ?? flow.nodes.find(n => !rank.has(n.id))?.id;
        if (!id) break;
        if (!rank.has(id)) enqueue(id, rows.length);
        for (const e of flow.edges.filter(e => e.from === id)) enqueue(e.to, rank.get(id)! + 1);
    }
    const size = new Map(flow.nodes.map(n => [n.id, { width: Math.max(120, n.label.length * 9 + 48), height: STATE_HEIGHT }]));
    const x = new Map<string, number>();
    rows.forEach((row, r) => {
        const above = (id: string) => flow.edges.filter(e => e.to === id && (rank.get(e.from) ?? r) < r).map(e => x.get(e.from)!);
        const ordered = r ? [...row].sort((a, b) => mean(above(a)) - mean(above(b))) : row;
        const widths = ordered.map(id => size.get(id)!.width);
        let at = -(widths.reduce((a, b) => a + b, 0) + STATE_GAP * (ordered.length - 1)) / 2;
        ordered.forEach((id, i) => { x.set(id, at + widths[i] / 2); at += widths[i] + STATE_GAP; });
    });
    const nodes = flow.nodes.map(node => ({ node, x: x.get(node.id)!, y: rank.get(node.id)! * STATE_RANK, ...size.get(node.id)! }));
    const at = new Map(nodes.map(n => [n.node.id, n]));
    const border = (box: Box, toward: Point): Point => {
        const [dx, dy] = [toward[0] - box.x, toward[1] - box.y];
        const t = Math.min(Math.abs((box.width / 2 + 4) / (dx || 1e-9)), Math.abs((box.height / 2 + 4) / (dy || 1e-9)));
        return [box.x + dx * t, box.y + dy * t];
    };
    const crosses = (from: Box, to: Box, bend: number) => nodes.some(n => n !== from && n !== to && [0.25, 0.5, 0.75].some(t => {
        const [px, py] = curvePoint(from, to, bend, t);
        return Math.abs(px - n.x) < n.width / 2 + 10 && Math.abs(py - n.y) < n.height / 2 + 10;
    }));
    const pairs = new Map<string, number>();
    const edges = flow.edges.map(edge => {
        const [from, to] = [at.get(edge.from)!, at.get(edge.to)!];
        if (from === to) {
            const [sx, sy] = [from.x + from.width / 2, from.y - 10];
            const path = `M ${sx} ${sy} C ${sx + 70} ${sy - 50}, ${sx + 70} ${sy + 70}, ${sx} ${sy + 20}`;
            return { edge, path, x: sx + 60, y: from.y };
        }
        const key = [edge.from, edge.to].sort().join(' ');
        const k = pairs.get(key) ?? 0;
        pairs.set(key, k + 1);
        const together = flow.edges.filter(e => [e.from, e.to].sort().join(' ') === key).length;
        let bend = (k - (together - 1) / 2) * 90 * (edge.from < edge.to ? 1 : -1);
        for (const extra of [0, 90, -90, 180, -180]) if (!crosses(from, to, bend + extra)) { bend += extra; break; }
        const control = curvePoint(from, to, bend, 0.5, true);
        const [start, end] = [border(from, control), border(to, control)];
        const [lx, ly] = curvePoint(from, to, bend, 0.5);
        const path = `M ${start[0]} ${start[1]} Q ${control[0]} ${control[1]}, ${end[0]} ${end[1]}`;
        // beside a rising or falling edge on the side it bends to, above a level one
        if (Math.abs(to.y - from.y) < STATE_HEIGHT) return { edge, path, x: lx, y: ly - (edge.note ? 26 : 14) };
        const side = lx !== (from.x + to.x) / 2 ? Math.sign(lx - (from.x + to.x) / 2) : Math.sign(to.x - from.x) || 1;
        return { edge, path, x: lx + side * 14, y: ly, anchor: side < 0 ? 'end' as const : 'start' as const };
    });
    const start = initial && at.get(initial.id)!;
    const xs = [...nodes.flatMap(n => [n.x - n.width / 2, n.x + n.width / 2]), ...edges.flatMap(e => {
        const width = textWidth(e.edge, 16) * 1.15;
        return e.anchor === 'start' ? [e.x, e.x + width] : e.anchor === 'end' ? [e.x - width, e.x] : [e.x - width / 2, e.x + width / 2];
    })];
    const [left, right] = [Math.min(...xs) - MARGIN * 2, Math.max(...xs) + MARGIN * 2];
    const top = -STATE_HEIGHT / 2 - (start ? 90 : MARGIN);
    const bottom = (rows.length - 1) * STATE_RANK + STATE_HEIGHT / 2 + MARGIN * 2;
    const shift = (p: string) => p.replace(/(-?[\d.]+) (-?[\d.]+)/g, (_, px: string, py: string) => `${Number(px) - left} ${Number(py) - top}`);
    return {
        width: right - left, height: bottom - top,
        nodes: nodes.map(n => ({ ...n, x: n.x - left, y: n.y - top })),
        edges: edges.map(e => ({ ...e, path: shift(e.path), x: e.x - left, y: e.y - top })),
        initial: start && { x: start.x - left, y: start.y - top - 80, to: [start.x - left, start.y - top - STATE_HEIGHT / 2 - 4] }
    };
}

/**
 * A point on the curve between two boxes bent by `bend` at its middle: the control point when `control` is set,
 * else the point at `t` of the quadratic curve from centre to centre.
 */
function curvePoint(from: Box, to: Box, bend: number, t: number, control = false): Point {
    const [dx, dy] = [to.x - from.x, to.y - from.y];
    const length = Math.hypot(dx, dy) || 1;
    const c: Point = [(from.x + to.x) / 2 - dy / length * bend * 2, (from.y + to.y) / 2 + dx / length * bend * 2];
    if (control) return c;
    const u = 1 - t;
    return [u * u * from.x + 2 * u * t * c[0] + t * t * to.x, u * u * from.y + 2 * u * t * c[1] + t * t * to.y];
}

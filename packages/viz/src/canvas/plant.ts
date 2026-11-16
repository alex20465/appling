import type { Placed, Point } from '../layout.js';
import type { TreeNode } from '../views.js';

export type { Point };

/** Between two generations that sprout together, and between two siblings. */
const GENERATION = 240;
const SIBLING = 45;
/** How long the 45 degree corners of a trace are. */
const CORNER = 6;
/** How many points every trace has, so one moves into another. */
const POINTS = 32;

/**
 * The traces of a circuit board, one per declaration that unfolded from another, along the route the layout gave it
 * (`route` in `layout.ts`), every corner cut. What a declaration leads to on one side is one net that shares its
 * first stretches. A module frames its declarations instead.
 */
export function traces(placed: Placed[], radius: (node: TreeNode) => number): Map<string, Point[]> {
    return new Map(placed.filter(p => p.route && p.parent).map(({ node, y, route, parent }) => {
        // a folded node shrinks into the node it hangs from
        return [node.id, cornered(y === parent!.y ? [[parent!.x, parent!.y + (node.side === 'down' ? 1 : -1) * radius(parent!.node)]] : route!)];
    }));
}

/** The joins of a pyramid: a trace like the others from a declaration to each one its unfolded side leads to that is drawn elsewhere already. */
export function joins(placed: Placed[]): { id: string, from: string, to: string, points: Point[] }[] {
    return placed.flatMap(p => (p.joins ?? []).map(join => ({ id: `${p.node.id}>${join.to}`, from: p.node.id, to: join.to, points: cornered(join.points) })));
}

/** Every corner cut at 45 degrees, at most half of the shorter side. Always `POINTS` points while they suffice: the last one repeats for the corners a trace does not take. */
function cornered(route: Point[]): Point[] {
    const points = route.filter(([x, y], i) => !i || x !== route[i - 1][0] || y !== route[i - 1][1]);
    const towards = ([x, y]: Point, [tx, ty]: Point, cut: number): Point => {
        const length = Math.hypot(tx - x, ty - y);
        return [x + (tx - x) / length * cut, y + (ty - y) / length * cut];
    };
    const cut = points.flatMap((point, i) => {
        if (!i || i === points.length - 1) return [point];
        const [before, after] = [points[i - 1], points[i + 1]];
        const size = Math.min(CORNER, Math.hypot(point[0] - before[0], point[1] - before[1]) / 2, Math.hypot(after[0] - point[0], after[1] - point[1]) / 2);
        return [towards(point, before, size), towards(point, after, size)];
    });
    return cut.length > POINTS ? cut : Array.from({ length: POINTS }, (_, i) => cut[Math.min(i, cut.length - 1)]);
}

export function pathOf(points: Point[]): string {
    return `M ${points.map(([x, y]) => `${x} ${y}`).join(' L ')}`;
}

/**
 * When each node starts to sprout, in ms. A node drawn before keeps its time; a new one waits for the node it grows
 * from when that is new too, and for its more relevant siblings, so a plant grows generation by generation.
 */
export function sproutDelays(placed: Placed[], before: Map<string, number>): Map<string, number> {
    const delays = new Map<string, number>();
    for (const { node, parent } of placed) {
        const turn = Math.min(parent?.node.children?.indexOf(node) ?? 0, 8) * SIBLING;
        delays.set(node.id, before.get(node.id) ?? (parent ? (before.has(parent.node.id) ? 0 : delays.get(parent.node.id)! + GENERATION) + turn : 0));
    }
    return delays;
}

/** How many nodes grow from each drawn node, itself not counted: what its stem has to carry. */
export function loads(placed: Placed[]): Map<string, number> {
    const carried = new Map<string, number>();
    for (const p of placed) for (let up = p.parent; up; up = up.parent) carried.set(up.node.id, (carried.get(up.node.id) ?? 0) + 1);
    return carried;
}

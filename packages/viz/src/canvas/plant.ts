import type { Placed } from '../layout.js';
import type { TreeNode } from '../views.js';

/** A cubic curve: start, two control points, end. */
export type Curve = [number, number, number, number, number, number, number, number];

/** Between two generations that sprout together, and between two siblings. */
const GENERATION = 240;
const SIBLING = 45;

/** From 0 to 1, always the same for the same text: a shoot keeps its bend and its leaves between drawings. */
export function grain(text: string, salt = 0): number {
    let hash = 2166136261 ^ salt;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    return ((hash >>> 0) % 1000) / 1000;
}

/** The stem from the top of the parent's circle up to the bottom of the child's, arriving upright and leaning a little to its own side on the way. */
export function stem({ node, x, y, parent }: Placed, radius: (node: TreeNode) => number): Curve {
    const [from, to] = [parent!.y - radius(parent!.node), y + radius(node)];
    const lean = (grain(node.id) - 0.5) * 36;
    return [parent!.x, from, parent!.x + lean, from + (to - from) * 0.55, x, from + (to - from) * 0.4, x, to];
}

export function pathOf([x0, y0, x1, y1, x2, y2, x3, y3]: Curve): string {
    return `M ${x0} ${y0} C ${x1} ${y1}, ${x2} ${y2}, ${x3} ${y3}`;
}

/** One or two leaves on a stem: where, and turned how far (degrees), on alternating sides. */
export function leaves(id: string, [x0, y0, x1, y1, x2, y2, x3, y3]: Curve): { x: number, y: number, angle: number }[] {
    const side = grain(id, 1) < 0.5 ? 1 : -1;
    return (grain(id, 2) < 0.45 ? [0.5] : [0.4, 0.68]).map((at, i) => {
        const t = at + grain(id, 3 + i) * 0.1;
        const u = 1 - t;
        const along = (a: number, b: number, c: number, d: number) => u ** 3 * a + 3 * u * u * t * b + 3 * u * t * t * c + t ** 3 * d;
        const slope = (a: number, b: number, c: number, d: number) => 3 * u * u * (b - a) + 6 * u * t * (c - b) + 3 * t * t * (d - c);
        const upwards = Math.atan2(slope(y0, y1, y2, y3), slope(x0, x1, x2, x3)) * 180 / Math.PI;
        return { x: along(x0, x1, x2, x3), y: along(y0, y1, y2, y3), angle: upwards + (i % 2 ? -side : side) * 52 };
    });
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

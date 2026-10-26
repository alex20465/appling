import type { TreeNode } from './views.js';

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

import ELK, { type ElkNode } from 'elkjs/lib/elk.bundled.js';
import type { Position } from '../../shared/snapshot.js';
import type { Card, View } from './model.js';

export interface Box {
    x: number;
    y: number;
    width: number;
    height: number;
    parent?: string;
}

const elk = new ELK();
export const CARD_WIDTH = 240;
const HEADER = 40;
const ROW = 20;

export function cardHeight(card: Card): number {
    return HEADER + card.rows.length * ROW + (card.rows.length ? 8 : 0);
}

/** Lays out the view with ELK; saved positions win over computed ones. */
export async function layoutView(current: View, saved: Record<string, Position>): Promise<Map<string, Box>> {
    const children = (group: string | undefined): ElkNode[] => [
        ...current.groups.filter(g => g.group === group).map(g => ({
            id: g.qn,
            layoutOptions: { 'elk.padding': '[top=44,left=20,bottom=20,right=20]' },
            children: children(g.qn)
        })),
        ...current.cards.filter(c => c.group === group).map(c => ({ id: c.qn, width: CARD_WIDTH, height: cardHeight(c) }))
    ];
    const root = await elk.layout({
        id: '(root)',
        layoutOptions: {
            'elk.algorithm': 'layered',
            'elk.direction': 'RIGHT',
            'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
            'elk.spacing.nodeNode': '32',
            'elk.layered.spacing.nodeNodeBetweenLayers': '64'
        },
        children: children(undefined),
        edges: current.links.map(l => ({ id: l.id, sources: [l.from], targets: [l.to] }))
    });
    const boxes = new Map<string, Box>();
    const collect = (node: ElkNode, parent?: string) => {
        for (const child of node.children ?? []) {
            const position = saved[child.id] ?? { x: child.x ?? 0, y: child.y ?? 0 };
            boxes.set(child.id, { ...position, width: child.width ?? CARD_WIDTH, height: child.height ?? HEADER, parent });
            collect(child, child.id);
        }
    };
    collect(root);
    return boxes;
}

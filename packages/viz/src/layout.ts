import Elk, { type ElkNode } from 'elkjs/lib/elk.bundled.js';
import type { EntityView, ViewSettings } from './views.js';

export interface Box {
    x: number;
    y: number;
    width: number;
    height: number;
    parent?: string;
}

/** elkjs is CommonJS: Node sees its module object, whose `default` is the class too. */
const elk = new Elk.default();
export const ENTITY_WIDTH = 200;
const ENTITY_HEIGHT = 40;
const EMPTY_MODULE = { width: 200, height: 56 };

/** Lays out the modules as nested groups around their entities with ELK. */
export async function layoutView(current: EntityView, direction: ViewSettings['direction']): Promise<Map<string, Box>> {
    const children = (module: string | undefined): ElkNode[] => [
        ...current.modules.filter(m => m.parent === module).map(m => {
            const inside = children(m.qn);
            return {
                id: m.qn,
                layoutOptions: { 'elk.padding': '[top=44,left=20,bottom=20,right=20]' },
                children: inside,
                ...(inside.length ? {} : EMPTY_MODULE)
            };
        }),
        ...current.entities.filter(e => module && e.module === module).map(e => ({ id: e.qn, width: ENTITY_WIDTH, height: ENTITY_HEIGHT }))
    ];
    const root = await elk.layout({
        id: '(root)',
        layoutOptions: {
            'elk.algorithm': 'layered',
            'elk.direction': direction,
            'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
            'elk.spacing.nodeNode': '32',
            'elk.layered.spacing.nodeNodeBetweenLayers': '80'
        },
        children: children(undefined),
        edges: current.associations.map(a => ({ id: a.id, sources: [a.from], targets: [a.to] }))
    });
    const boxes = new Map<string, Box>();
    const collect = (node: ElkNode, parent?: string) => {
        for (const child of node.children ?? []) {
            boxes.set(child.id, { x: child.x ?? 0, y: child.y ?? 0, width: child.width ?? ENTITY_WIDTH, height: child.height ?? ENTITY_HEIGHT, parent });
            collect(child, child.id);
        }
    };
    collect(root);
    return boxes;
}


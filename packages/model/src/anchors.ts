import type { AstNode } from 'langium';
import type { Action, CallStep, Messages, Navigation, NavItem, Page, UseCase } from '@appling/lang';

/**
 * Sub-anchors: stable addresses for declaring lines that are not graph elements (#20), so they can carry code
 * references, an implementation state, a gutter mark and a jump like elements do, without becoming graph nodes.
 * An address is `<element>#<kind>[<key>]`:
 *
 * - `sales.PlaceOrder#step[2]`: the second step (`step` or `await`) of a use case, counted from 1;
 *   `sales.PlaceOrder#step[2].on[OutOfStock]` the handler of that step for an error.
 * - `sales.Order.place#requires[1]`: the first `requires` of an action.
 * - `shop.Orders#component[1]`: the first component (`list`, `detail`, `form`) of a page.
 * - `shop.Main#item[Orders/Open]`: a navigation item by its label, nested items by the path of labels.
 * - `shop.Texts#message[order.placed]`: a message by its key.
 *
 * Steps, requires and components are addressed by position (their order is what they mean), items and messages by
 * name. A second sibling with the same name gets `#2` after the key, as unnamed elements do.
 */
export type AnchorKind = 'step' | 'on' | 'requires' | 'component' | 'item' | 'message';

/** A sub-anchor as the graph lists it (`Graph.anchors`). */
export interface GraphAnchor {
    address: string;
    /** The element whose line it is part of. */
    owner: string;
    kind: AnchorKind;
}

export interface SubAnchor extends GraphAnchor {
    node: AstNode;
}

const ADDRESS = /#(step|requires|component|item|message)\[/;

/** Whether a name is a sub-anchor's address rather than an element's qualified name. */
export function isAnchorAddress(name: string): boolean {
    return ADDRESS.test(name);
}

/** The element a sub-anchor belongs to; an element's own name is returned as it is. */
export function anchorOwner(name: string): string {
    const match = ADDRESS.exec(name);
    return match ? name.slice(0, match.index) : name;
}

/** The sub-anchors of every element in `qns` (element node to qualified name), in document order. */
export function subAnchors(qns: Map<AstNode, string>): SubAnchor[] {
    const anchors: SubAnchor[] = [];
    for (const [node, owner] of qns) {
        const add = (kind: AnchorKind, key: string, at: AstNode, base = owner) => {
            anchors.push({ address: `${base}#${kind}[${key}]`, owner, kind, node: at });
            return `${base}#${kind}[${key}]`;
        };
        // by $type, so the module stays free of the language at run time (the IDE client reads addresses with it)
        if (node.$type === 'UseCase') {
            (node as UseCase).steps.forEach((step, i) => {
                const address = add('step', String(i + 1), step);
                if (step.$type === 'CallStep') {
                    const seen = new Map<string, number>();
                    for (const handler of (step as CallStep).handlers) {
                        const key = unique(handler.error.$refText, seen);
                        anchors.push({ address: `${address}.on[${key}]`, owner, kind: 'on', node: handler });
                    }
                }
            });
        } else if (node.$type === 'Action') {
            (node as Action).preconditions.forEach((precondition, i) => add('requires', String(i + 1), precondition));
        } else if (node.$type === 'Page') {
            (node as Page).components.forEach((component, i) => add('component', String(i + 1), component));
        } else if (node.$type === 'Navigation') {
            const visit = (items: NavItem[], path: string) => {
                const seen = new Map<string, number>();
                for (const item of items) {
                    const key = `${path}${unique(item.label, seen)}`;
                    add('item', key, item);
                    visit(item.children, `${key}/`);
                }
            };
            visit((node as Navigation).items, '');
        } else if (node.$type === 'Messages') {
            const seen = new Map<string, number>();
            for (const message of (node as Messages).entries) add('message', unique(message.key, seen), message);
        }
    }
    return anchors;
}

function unique(key: string, seen: Map<string, number>): string {
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    return count === 1 ? key : `${key}#${count}`;
}

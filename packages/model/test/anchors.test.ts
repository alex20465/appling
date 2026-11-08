import { expect, test } from 'vitest';
import type { Model } from '@appling/lang';
import { buildWorkspace } from '../../lang/test/workspace.js';
import { anchorOwner, anchorStates, buildGraph, implementationStates, isAnchorAddress, lineMarks, qualifiedNames, subAnchors, type ResolvedReference } from '../src/index.js';

const SOURCE = `module m {
    entity Order {
        total: Int
    }
    action Place on Order {
        input { total: Int }
        requires { total > 0 } else Empty
        requires { total < 1000 }
        effect { set total = total }
        errors Empty
    }
    query Open from Order { where { total > 0 } }
    projection Row from Order { total }
    usecase Checkout(order: Order, total: Int) {
        step Place(order, total)
            on Empty do Place(order, 1)
        await Placed
    }
    event Placed { total: Int }
    page Orders route "/orders" {
        list Open as Row
        form Place
    }
    navigation Main {
        "Orders" -> Orders {
            "Open" -> Orders
        }
        "Orders" -> Orders
    }
    messages Texts {
        order.placed = "Placed"
    }
}
`;

async function model() {
    const { documents, services } = await buildWorkspace({ 'm.appling': SOURCE });
    const models = documents.map(doc => doc.parseResult.value as Model);
    return { models, graph: buildGraph(models, services) };
}

test('declaring lines that are not elements get sub-anchor addresses, listed in the graph but not as nodes', async () => {
    const { models, graph } = await model();
    expect(graph.anchors).toEqual([
        { address: 'm.Place#requires[1]', owner: 'm.Place', kind: 'requires' },
        { address: 'm.Place#requires[2]', owner: 'm.Place', kind: 'requires' },
        { address: 'm.Checkout#step[1]', owner: 'm.Checkout', kind: 'step' },
        { address: 'm.Checkout#step[1].on[Empty]', owner: 'm.Checkout', kind: 'on' },
        { address: 'm.Checkout#step[2]', owner: 'm.Checkout', kind: 'step' },
        { address: 'm.Orders#component[1]', owner: 'm.Orders', kind: 'component' },
        { address: 'm.Orders#component[2]', owner: 'm.Orders', kind: 'component' },
        { address: 'm.Main#item[Orders]', owner: 'm.Main', kind: 'item' },
        { address: 'm.Main#item[Orders/Open]', owner: 'm.Main', kind: 'item' },
        { address: 'm.Main#item[Orders#2]', owner: 'm.Main', kind: 'item' },
        { address: 'm.Texts#message[order.placed]', owner: 'm.Texts', kind: 'message' }
    ]);
    expect(graph.nodes.some(n => isAnchorAddress(n.qn))).toBe(false);
    // each address stands for its line in the source
    const text = (address: string) => {
        const node = subAnchors(qualifiedNames(models)).find(a => a.address === address)!.node;
        return SOURCE.slice(node.$cstNode!.offset, node.$cstNode!.end);
    };
    expect(text('m.Checkout#step[2]')).toBe('await Placed');
    expect(text('m.Checkout#step[1].on[Empty]')).toBe('on Empty do Place(order, 1)');
    expect(text('m.Place#requires[2]')).toBe('requires { total < 1000 }');
    expect(text('m.Orders#component[2]')).toBe('form Place');
    expect(text('m.Texts#message[order.placed]')).toBe('order.placed = "Placed"');
    expect(isAnchorAddress('m.Checkout#step[1].on[Empty]')).toBe(true);
    expect(isAnchorAddress('m.Order.invariant["a"]#2')).toBe(false);
    expect(anchorOwner('m.Main#item[Orders/Open]')).toBe('m.Main');
    expect(anchorOwner('m.Order')).toBe('m.Order');
});

test('a sub-anchor carries code references and its own state; without one it shows its element\'s', async () => {
    const { graph } = await model();
    const reference = (qn: string, status: ResolvedReference['status']): ResolvedReference => ({ qn, file: 'x.py', start: 1, end: 2, anchor: 'x', status });
    const references = [reference('m.Checkout#step[1]', 'current'), reference('m.Checkout#step[2]', 'broken'), reference('m.Checkout#step[9]', 'orphaned')];
    const states = implementationStates(graph, { references, tasks: [], outstanding: new Set() });
    expect(states['m.Checkout'].state).toBe('unimplemented');
    // the elements' states stay the elements'
    expect(Object.keys(states).some(isAnchorAddress)).toBe(false);
    const anchors = anchorStates(graph, references, states);
    expect(anchors['m.Checkout#step[1]']).toEqual({ state: 'implemented', references: 1, tasks: 0, outstanding: false });
    expect(anchors['m.Checkout#step[2]'].state).toBe('broken');
    expect(anchors['m.Place#requires[1]'].state).toBe(states['m.Place'].state);
    expect(anchors['m.Checkout#step[9]']).toBeUndefined();
    // changed with its element: generation would write it again
    const changed = implementationStates(graph, { references, tasks: [], outstanding: new Set(['m.Checkout']) });
    expect(anchorStates(graph, references, changed)['m.Checkout#step[1]']).toMatchObject({ state: 'unimplemented', outstanding: true });
    // a gutter mark on its own line
    const marks = lineMarks({
        'm.Checkout': { uri: 'u', start: SOURCE.indexOf('usecase'), end: SOURCE.indexOf('event') },
        'm.Checkout#step[1]': { uri: 'u', start: SOURCE.indexOf('step Place'), end: SOURCE.indexOf('on Empty') }
    }, { u: SOURCE }, { ...states, ...anchors });
    expect(marks.u.map(m => [m.qn, m.state])).toEqual([['m.Checkout', 'unimplemented'], ['m.Checkout#step[1]', 'implemented']]);
});

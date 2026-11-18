import { expect, test } from 'vitest';
import type { Model } from '@appling/lang';
import { buildGraph, diffGraphs, Simulator, withRemoved } from '@appling/model';
import { buildWorkspace, examples } from '../../lang/test/workspace.js';
import { bandsOf, layoutFlow, layoutTree } from '../src/layout.js';
import { joins, loads, sproutDelays, traces } from '../src/canvas/plant.js';
import {
    abilities, actionSummary, anchorOf, cardView, changeMarks, elementAt, implementationMarks, sessionMarks, entityActions, factOf, flowView, GraphIndex, growTree, lensOf, linked, modelPulse, peers, policyText, relations, revealPath, sideId, trailOf, viewFor,
    type Card, type Flow, type TreeNode
} from '../src/views.js';

const DOMAIN = { lens: 'domain' as const, linkEntities: false };

async function indexOf(sources: Record<string, string>) {
    const { documents, services } = await buildWorkspace(sources);
    return new GraphIndex(buildGraph(documents.map(d => d.parseResult.value as Model), services));
}

const CATALOG = `module catalog {
  enum Kind { book }
  entity Product {
    kind: Kind
    tags: ProductTag[]
  }
  entity Tag {
    label: String
  }
  entity link ProductTag {
    product: Product
    tag: Tag?
  }
}
`;

/** Each node as its level, label and what it unfolds upwards and downwards, with its children indented below it. */
const outline = (node: TreeNode, depth = 0): string[] => [
    `${'  '.repeat(depth)}${node.type === 'element' ? `L${node.level} ${node.label} ${node.up}↑ ${node.down}↓${node.links ? ` also ${node.links.join(', ')}` : ''}` : `${node.label} (${node.count})`}`,
    ...(node.children ?? []).flatMap(c => outline(c, depth + 1))
];

test('the pyramid starts folded at the seed and unfolds modules, then the declarations of the entry level, then each side of a declaration', async () => {
    const index = await indexOf(examples());
    expect(outline(growTree(index, DOMAIN, new Set(), 'shop'))).toEqual(['shop (2)']);
    const open = new Set(['~', '~/sales', sideId('~/sales/sales.Order', 'up'), sideId('~/sales/sales.Order/sales.Cancel', 'up')]);
    expect(outline(growTree(index, DOMAIN, open))).toEqual([
        'model (2)',
        '  sales (3)',
        '    L1 Order 13↑ 0↓',
        '      L2 Cancel 4↑ 0↓ also sales.Checkout, crm.Clerk',
        '        L4 Orders 4↑ 0↓',
        '        L4 OrderDetail 4↑ 0↓',
        '      L2 PlaceOrder 5↑ 0↓',
        '      L2 PaymentReceived 1↑ 0↓',
        '      L2 OrderPlaced 0↑ 0↓',
        '      L2 OrderFlow 0↑ 0↓',
        '      L2 ExpireDrafts 0↑ 0↓',
        '      L3 Checkout 1↑ 0↓',
        '      L3 OpenOrders 2↑ 0↓',
        '      L3 OrdersOf 1↑ 0↓',
        '      L3 OrderSummary 3↑ 0↓',
        '      L5 crm.Clerk 0↑ 0↓',
        '      L5 Customer 0↑ 0↓',
        '      L5 Shopper 0↑ 0↓',
        '    L1 Line 0↑ 0↓',
        '    L1 OrderStatus 2↑ 0↓',
        '  crm (1)'
    ]);
    expect(growTree(index, DOMAIN, open).children!.find(m => m.label === 'sales')!.fact).toBe('1 entity · 1 value · 1 enum');
});

test('an element with an annotation carries it as its note', async () => {
    const index = await indexOf({ 'm.appling': 'module m { entity A holds "Mirrors the ERP" { } entity B { } }' });
    const elements = growTree(index, DOMAIN, new Set(['~', '~/m'])).children![0].children!;
    expect(elements.map(e => [e.label, e.note])).toEqual([['A', { keyword: 'holds', text: 'Mirrors the ERP' }], ['B', undefined]]);
});

test('a level in between unfolds both ways, and away from it a branch keeps its direction', async () => {
    const index = await indexOf(examples());
    const open = new Set(['~', '~/sales', sideId('~/sales/sales.OpenOrders', 'up'), sideId('~/sales/sales.OpenOrders', 'down'), sideId('~/sales/sales.OpenOrders/sales.Orders', 'up')]);
    const query = growTree(index, { ...DOMAIN, lens: 'application' }, open).children!.find(m => m.label === 'sales')!.children!.find(n => n.qn === 'sales.OpenOrders')!;
    expect(outline(query)).toEqual([
        'L3 OpenOrders 2↑ 2↓',
        '  L4 PublicApi 5↑ 0↓',
        '  L4 Orders 4↑ 0↓',
        '    L5 crm.Clerk 0↑ 0↓',
        '    L5 Customer 0↑ 0↓',
        '    L5 Shopper 0↑ 0↓',
        '    L5 crm.Employee 0↑ 0↓',
        '  L1 Order 0↑ 0↓',
        '  L1 OrderStatus 0↑ 0↓'
    ]);
    expect(query.children!.map(n => n.side)).toEqual(['up', 'up', 'down', 'down']);
});

test('the top level leads through the pages and interfaces that expose what its policies name', async () => {
    const index = await indexOf(examples());
    const names = (qn: string, side: 'up' | 'down') => linked(index, qn, side).map(n => n.qn).sort();
    // what a page of the role already exposes shows under the page, the entities its policies name stay direct
    expect(names('crm.Clerk', 'down')).toEqual(['crm.Account', 'sales.Order', 'sales.OrderDetail', 'sales.Orders', 'sales.PublicApi']);
    expect(names('crm.Employee', 'down')).toEqual(['sales.OrderDetail', 'sales.Orders', 'sales.PublicApi']);
    expect(names('sales.Orders', 'up')).toEqual(['crm.Clerk', 'crm.Employee', 'sales.Customer', 'sales.Shopper']);
    expect(names('sales.Orders', 'down')).toEqual(['sales.Cancel', 'sales.OpenOrders', 'sales.OrderSummary']);
    expect(peers(index, 'sales.Order.customer').sort()).toEqual(['crm.Account', 'sales.Line', 'sales.OrderStatus']);
    expect(peers(index, 'crm.Clerk')).toEqual(['crm.Employee']);
});

test('an empty module shows on every level', async () => {
    const index = await indexOf({ ...examples(), 'billing.appling': 'module billing {\n}\n' });
    const open = new Set(['~', '~/billing']);
    const behavior = growTree(index, { ...DOMAIN, lens: 'behavior' }, open);
    expect(behavior.children!.find(m => m.label === 'billing')).toMatchObject({ fact: 'empty', count: 0 });
    expect(behavior.children!.map(m => m.label)).not.toContain('crm');
});

test('a trail draws only the elements shown one after another, each unfolded where the pyramid already has it', async () => {
    const index = await indexOf(examples());
    const { unfolded, trail, ids } = trailOf(index, DOMAIN, ['sales.Order', 'sales.Cancel', 'crm.Account', 'sales.Main']);
    expect(ids).toEqual(['~/sales/sales.Order', '~/sales/sales.Order/sales.Cancel', '~/crm/crm.Account', undefined]);
    const tree = growTree(index, DOMAIN, unfolded, 'shop', trail);
    expect(tree.children!.map(m => [m.label, m.children!.map(n => n.label)])).toEqual([['sales', ['Order']], ['crm', ['Account']]]);
    const cancel = tree.children![0].children![0].children!.find(n => n.qn === 'sales.Cancel')!;
    // what Order already drew is joined, not drawn again
    expect(cancel.children!.map(n => n.label)).toEqual(['Orders', 'OrderDetail']);
    expect(cancel.links).toEqual(['sales.Checkout', 'crm.Clerk']);
    expect(trailOf(index, { ...DOMAIN, lens: 'behavior' }, ['sales.OrderFlow']).ids).toEqual(['~/sales/sales.OrderFlow']);
    expect([lensOf('Machine'), lensOf('Field')]).toEqual(['behavior', undefined]);
});

test('a folded trail draws each element in its module without what unfolds from it', async () => {
    const index = await indexOf(examples());
    const { unfolded, trail, ids } = trailOf(index, DOMAIN, ['sales.Order', 'sales.OrderStatus', 'sales.Main'], true);
    expect(ids).toEqual(['~/sales/sales.Order', '~/sales/sales.OrderStatus', undefined]);
    const drawn: string[] = [];
    const walk = (node: { id: string, children?: unknown[] }) => { drawn.push(node.id); (node.children as typeof node[] | undefined)?.forEach(walk); };
    walk(growTree(index, DOMAIN, unfolded, undefined, trail));
    expect(drawn).toEqual(['~', '~/sales', '~/sales/sales.Order', '~/sales/sales.OrderStatus']);
});

test('facts say what a declaration is about, and a selection reveals its declaration in the lens that has it', async () => {
    const index = await indexOf(examples());
    const fact = (qn: string) => factOf(index, index.nodes.get(qn)!);
    expect(fact('sales.Order')).toBe('8 fields · 2 actions on it');
    expect(fact('sales.Cancel')).toBe('on Order · draft, placed → cancelled');
    expect(fact('sales.OrderFlow')).toBe('on Order.status · 4 states');
    expect(fact('sales.ExpireDrafts')).toBe('every 0 3 * * * · runs Cancel');
    expect(fact('sales.OpenOrders')).toBe('from Order');
    expect(revealPath(index, { ...DOMAIN, lens: 'behavior' }, 'sales.PlaceOrder.EmptyOrder')).toEqual(['~', '~/sales']);
    expect(revealPath(index, DOMAIN, 'sales.PlaceOrder')).toEqual([]);
});

test('an entity lists its actions with the transitions they drive, and who creates it', async () => {
    const index = await indexOf(examples());
    expect(entityActions(index, 'sales.Order')).toEqual([
        { qn: 'sales.PlaceOrder', transitions: ['draft -> placed'], creates: false },
        { qn: 'sales.Cancel', transitions: ['draft, placed -> cancelled'], creates: false }
    ]);
    const catalog = await indexOf({ 'c.appling': 'module c {\n  entity Tag {\n    label: String\n  }\n  action AddTag {\n    input {\n      label: String\n    }\n    effect {\n      create Tag { label = label }\n    }\n  }\n}\n' });
    expect(entityActions(catalog, 'c.Tag')).toEqual([{ qn: 'c.AddTag', transitions: [], creates: true }]);
});

test('an action summary says what it takes, requires and changes', async () => {
    const index = await indexOf(examples());
    expect(actionSummary(index, 'sales.PlaceOrder')).toEqual({
        on: 'sales.Order',
        inputs: [],
        requires: ['requires { lines.size() > 0 } else EmptyOrder'],
        changes: ['set placed_at = now', 'OrderFlow: draft -> placed', '  emit OrderPlaced { order = this }'],
        errors: ['EmptyOrder'],
        consistency: undefined
    });
    expect(actionSummary(index, 'sales.Cancel').inputs).toEqual(['reason: String?']);
});

test('relations lift members to declarations and group them by layer', async () => {
    const index = await indexOf(examples());
    const grouped = (qn: string, direction: 'uses' | 'usedBy') => Object.fromEntries([...relations(index, qn, direction)].map(([l, r]) => [l, r.map(x => x.qn)]));
    const via = (qn: string, direction: 'uses' | 'usedBy') => Object.fromEntries([...relations(index, qn, direction).values()].flat().map(r => [r.qn, r.via]));
    expect(grouped('sales.Order', 'usedBy')).toEqual({
        behavior: ['sales.OrderPlaced', 'sales.PaymentReceived', 'sales.PlaceOrder', 'sales.Cancel', 'sales.OrderFlow', 'sales.ExpireDrafts'],
        application: ['sales.OpenOrders', 'sales.OrdersOf', 'sales.OrderSummary', 'sales.Checkout'],
        cross: ['sales.ClerkCancelsDraft', 'sales.EmptyOrderIsRefused', 'sales.OnlyOwnOrders']
    });
    expect(grouped('sales.Order', 'uses')).toEqual({ domain: ['crm.Account', 'sales.Line', 'sales.OrderStatus'], cross: ['crm.Clerk', 'sales.Customer', 'sales.Shopper'] });
    expect(via('sales.Order.placed_at', 'usedBy')).toEqual({ 'sales.PlaceOrder': ['effect[set placed_at]'], 'sales.OpenOrders': [], 'sales.OrdersOf': [] });
    expect(via('sales.Order', 'uses')['crm.Account']).toEqual(['customer']);
    expect(via('sales.PlaceOrder', 'usedBy')).toMatchObject({ 'sales.OrderFlow': ['transition[draft->placed]'], 'sales.PublicApi': ['endpoint[POST /orders/{id}/place]'] });
    expect(grouped('sales.PlaceOrder', 'usedBy')).toEqual({
        behavior: ['sales.OrderFlow'], application: ['sales.Checkout'], interface: ['sales.PublicApi'], experience: ['sales.OrderDetail'],
        cross: ['sales.EmptyOrderIsRefused', 'sales.OnlyOwnOrders']
    });
});

test('change marks lift members to their declaration and skip removed elements', async () => {
    const index = await indexOf(examples());
    const marks = changeMarks(index, { added: ['sales.OrderFlow', 'sales.Order.placed_at', 'sales.Gone'], changed: ['crm.Account', 'sales.OrderFlow'] });
    expect(Object.fromEntries(marks)).toEqual({ 'sales.OrderFlow': 'added', 'sales.Order': 'changed', 'crm.Account': 'changed' });
});

test('session marks lift members to their declaration; the first session wins', async () => {
    const index = await indexOf(examples());
    const marks = sessionMarks(index, [
        { element: 'sales.Order.status', color: 'green', label: 'Totals', session: 'a' },
        { element: 'sales.Order', color: 'blue', label: 'Status', session: 'b' },
        { element: 'sales.Gone', color: 'blue', label: 'Status', session: 'b' }
    ]);
    expect([...marks].map(([qn, m]) => [qn, m.session])).toEqual([['sales.Order', 'a']]);
});

test('implementation marks roll members up into their declaration and declarations into their module', async () => {
    const index = await indexOf(examples());
    const states = Object.fromEntries(index.graph.nodes.map(n => [n.qn, { state: 'implemented' as const }]));
    states['sales.Order.status'] = { state: 'unimplemented' as const };
    states['crm.Account'] = { state: 'unimplemented' as const };
    const marks = implementationMarks(index, states);
    expect(marks.get('sales.Order')).toBe('partial');
    expect(marks.get('sales.OrderStatus')).toBe('implemented');
    expect(marks.get('sales')).toBe('partial');
    expect(marks.get('crm')).toBe('partial');
    expect(marks.has('sales.Order.status')).toBe(false);
});

test('removed elements put back into the graph are marked removed, their members lift as changed', async () => {
    const graphOf = async (source: string) => {
        const { documents, services } = await buildWorkspace({ 'm.appling': source });
        return buildGraph(documents.map(d => d.parseResult.value as Model), services);
    };
    const before = await graphOf('module m {\n  entity A {\n    x: String\n    y: String\n  }\n  entity B {\n    z: String\n  }\n}');
    const after = await graphOf('module m {\n  entity A {\n    x: String\n  }\n}');
    const diff = diffGraphs(before, after);
    const index = new GraphIndex(withRemoved(before, after, diff));
    expect(Object.fromEntries(changeMarks(index, diff))).toEqual({ 'm.A': 'changed', 'm.B': 'removed' });
    expect(Object.fromEntries(changeMarks(index, diff, true))).toEqual({ 'm.A': 'changed', 'm.B': 'removed', m: 'changed' });
    const drawn = (node: TreeNode): string[] => [...(node.type === 'element' ? [node.qn!] : []), ...(node.children ?? []).flatMap(drawn)];
    expect(drawn(growTree(index, DOMAIN, new Set(['~', '~/m'])))).toEqual(['m.A', 'm.B']);
});

test('the element at an offset is the innermost one', () => {
    const locations = { m: { uri: 'u', start: 0, end: 100 }, 'm.E': { uri: 'u', start: 10, end: 50 }, 'm.E.f': { uri: 'u', start: 20, end: 30 } };
    expect([5, 15, 25, 60].map(o => elementAt(locations, 'u', o))).toEqual(['m', 'm.E', 'm.E.f', 'm']);
});

test('abilities group what an actor may do, pages with the actions they offer', async () => {
    const index = await indexOf(examples());
    const groups = abilities(index, new Simulator(index.graph).access('sales.Shopper'));
    expect([...groups.keys()]).toEqual(['Actions', 'Pages', 'Use cases', 'Queries', 'Data']);
    expect(groups.get('Pages')!.map(p => [p.target, p.verdict, p.offers!.map(o => `${o.target} ${o.verdict}`)])).toEqual([
        ['sales.Orders', 'depends', ['sales.Cancel no']],
        ['sales.OrderDetail', 'depends', ['sales.PlaceOrder depends', 'sales.Cancel no']]
    ]);
    expect(policyText(index, 'sales.Order.policy[read]')).toBe('Order policy[read]: actor.is(crm.Clerk) || (actor.is(Customer) && customer == actor.account)');
    expect(policyText(index, 'sales.PlaceOrder.policy[]')).toBe('PlaceOrder policy: actor.is(Customer) && customer == actor.account');
});

const text = (cards: Card[]) => cards.map(card => ({
    title: `${card.title}${card.tag ? ` (${card.tag})` : ''}`,
    sections: card.sections.map(s => `${s.title ?? ''}: ${s.rows.map(r => `${r.text}${r.note ? ` [${r.note}]` : ''}`).join('; ')}`)
}));

/** Nodes as `label (tag)`, edges as `from -label-> to [note]`, by label. */
const chart = (flow: Flow) => {
    const label = new Map(flow.nodes.map(n => [n.id, n.label]));
    return {
        nodes: flow.nodes.map(n => `${n.label}${n.tag ? ` (${n.tag})` : ''}${n.note ? ` [${n.note}]` : ''}`),
        edges: flow.edges.map(e => `${label.get(e.from)} -${e.label ?? ''}-> ${label.get(e.to)}${e.note ? ` [${e.note}]` : ''}`)
    };
};

test('a machine view is a flowchart of the states with one edge per transition and state it leaves', async () => {
    const index = await indexOf(examples());
    const flow = flowView(index, 'machine', ['sales.OrderFlow']);
    expect(chart(flow)).toEqual({
        nodes: ['draft (initial)', 'placed', 'paid (final)', 'cancelled (final)'],
        edges: ['draft -PlaceOrder-> placed', 'placed -on PaymentReceived-> paid', 'draft -Cancel-> cancelled [when !has(paid_at) · job ExpireDrafts]', 'placed -Cancel-> cancelled [when !has(paid_at)]']
    });
    expect(flow.edges.map(e => e.qn)).toEqual(['sales.PlaceOrder', 'sales.PaymentReceived', 'sales.Cancel', 'sales.Cancel']);
    const placed = layoutFlow(flow);
    const y = new Map(placed.nodes.map(n => [n.node.label, n.y]));
    expect(y.get('draft')).toBeLessThan(y.get('placed')!);
    expect(y.get('placed')).toBeLessThan(y.get('paid')!);
    expect(placed.nodes.every(n => n.x - n.width / 2 >= 0 && n.x + n.width / 2 <= placed.width)).toBe(true);
    const corners = placed.edges.map(e => e.path.slice(2).split(' L ').map(p => p.split(' ').map(Number)));
    expect(corners.every(points => points.slice(1).every(([x, y], i) => x === points[i][0] || y === points[i][1]))).toBe(true);
});

test('one action of several targets is one edge per target', async () => {
    const index = await indexOf({ 'm.appling': `module m {
  enum S { a b c }
  entity E {
    s: S state default a
  }
  action Go on E {
  }
  machine F on E.s {
    transition a -> b via Go
    transition a -> c via Go
  }
}
` });
    expect(chart(flowView(index, 'machine', ['m.F'])).edges).toEqual(['a -Go-> b', 'a -Go-> c']);
});

test('an action card says between which states it moves, who may run it and what it requires and changes', async () => {
    const cards = cardView(await indexOf(examples()), 'action', ['sales.PlaceOrder']);
    expect(text(cards)).toEqual([{
        title: 'PlaceOrder (on Order)',
        sections: [
            'States: draft → placed', 'Who: Employee: no; Shopper: depends', 'Requires: requires { lines.size() > 0 } else EmptyOrder',
            'Changes: set placed_at = now; emit OrderPlaced { order = this }', 'Errors: EmptyOrder',
            'Used by: Checkout [usecase]; PublicApi [interface]; OrderDetail [page]; EmptyOrderIsRefused [scenario]; OnlyOwnOrders [scenario]'
        ]
    }]);
});

test('a use case is a flowchart of its steps with its error handlers and timeouts branching off, and event cards list emitters and consumers', async () => {
    const index = await indexOf(examples());
    expect(chart(flowView(index, 'usecase', ['sales.Checkout']))).toEqual({
        nodes: ['Checkout (usecase) [order: Order]', 'PlaceOrder', 'Payments.Charge', 'Cancel', 'await PaymentReceived', 'Cancel'],
        edges: ['Checkout --> PlaceOrder', 'PlaceOrder --> Payments.Charge', 'Payments.Charge -Declined-> Cancel', 'Payments.Charge --> await PaymentReceived', 'await PaymentReceived -timeout 24h-> Cancel']
    });
    expect(text(cardView(index, 'event', ['sales.OrderPlaced', 'sales.PaymentReceived']))).toEqual([
        { title: 'OrderPlaced (event)', sections: ['Fields: order: Order', 'Emitted by: PlaceOrder'] },
        { title: 'PaymentReceived (event)', sections: ['Fields: order: Order', 'Triggers: OrderFlow: placed → paid', 'Resumes: Checkout'] }
    ]);
    expect([viewFor('Machine'), viewFor('Module'), viewFor('Entity'), viewFor('Field')]).toEqual(['machine', 'node', 'node', undefined]);
    expect(anchorOf(index, 'sales.Order.status', new Set(['sales', 'sales.Order']))).toBe('sales.Order');
});

test('a new model pulses the elements it added or changed inside', async () => {
    const before = await indexOf({ 'm.appling': 'module m {\n  entity A {\n    x: String\n  }\n  entity B {\n    y: String\n  }\n}' });
    const after = await indexOf({ 'm.appling': 'module m {\n  entity A {\n    renamed: String\n  }\n  entity B {\n    y: String\n  }\n  entity C {\n    z: String\n  }\n}' });
    expect(Object.fromEntries(modelPulse(before, after, ['m', 'm.A', 'm.B', 'm.C', 'm.A']))).toEqual({ m: 'changed', 'm.A': 'changed', 'm.C': 'added' });
    expect(modelPulse(after, after, ['m', 'm.A']).size).toBe(0);
});

test('new nodes sprout generation by generation, siblings one after another', async () => {
    const index = await indexOf(examples());
    const first = layoutTree(growTree(index, DOMAIN, new Set(['~'])), 1);
    const seedOnly = sproutDelays(first, new Map());
    expect(seedOnly.get('~')).toBe(0);
    expect(first.filter(p => p.parent).map(p => seedOnly.get(p.node.id))).toEqual(expect.arrayContaining([240, 285]));
    const module = first.find(p => p.node.type === 'module')!.node.id;
    const next = layoutTree(growTree(index, DOMAIN, new Set(['~', module])), 1);
    const delays = sproutDelays(next, seedOnly);
    expect(delays.get(module)).toBe(seedOnly.get(module));
    const shoots = next.filter(p => p.parent?.node.id === module);
    expect(Math.min(...shoots.map(p => delays.get(p.node.id)!))).toBe(0);
    expect(loads(next).get(module)).toBe(shoots.length);
});

test('unfolding a declaration moves none of its level past another: each keeps its row and its place in it', async () => {
    const index = await indexOf(examples());
    const open = new Set(['~', '~/sales', sideId('~/sales/sales.Order', 'up')]);
    const level = (unfolded: Set<string>) => layoutTree(growTree(index, DOMAIN, unfolded), 1).filter(p => p.node.level === 2);
    const order = (chips: ReturnType<typeof level>) => [...chips].sort((a, b) => a.y - b.y || a.x - b.x).map(p => p.node.label);
    const rowOf = (chips: ReturnType<typeof level>) => Object.fromEntries(chips.map(p => [p.node.label, new Set(chips.filter(c => c.y < p.y).map(c => c.y)).size]));
    const before = level(open);
    expect(before.length).toBe(6);
    for (const { node } of before.filter(p => p.node.up)) {
        const after = level(new Set([...open, sideId(node.id, 'up')]));
        expect(order(after), node.label).toEqual(order(before));
        expect(rowOf(after), node.label).toEqual(rowOf(before));
    }
});

test('however far the pyramid unfolds, every level keeps its band, no nodes overlap and no trace runs through a node', async () => {
    const index = await indexOf(examples());
    const lenses = ['domain', 'behavior', 'application', 'interfaces', 'access'] as const;
    for (const lens of lenses) {
        const settings = { lens, linkEntities: true };
        const entry = lenses.indexOf(lens) + 1;
        const open = new Set(['~']);
        let after = layoutTree(growTree(index, settings, open), entry);
        for (let step = 0; step < 5; step++) {
            for (const { node } of after) open.add(node.id).add(sideId(node.id, 'up')).add(sideId(node.id, 'down'));
            after = layoutTree(growTree(index, settings, open), entry);
        }
        const chips = after.filter(p => p.node.type === 'element');
        // every declaration is drawn once, and every join leads to a drawn one on another level
        expect(new Set(chips.map(p => p.node.qn)).size).toBe(chips.length);
        const joined = joins(after);
        expect(joined.length).toBe(after.reduce((all, p) => all + (p.node.links?.length ?? 0), 0));
        // a join runs in straight stretches and through no chip but the two it joins
        for (const { id, from, to, points } of joined) for (const [i, [x2, y2]] of points.slice(1).entries()) {
            const [x1, y1] = points[i];
            for (const t of [0.1, 0.3, 0.5, 0.7, 0.9]) for (const chip of chips) if (chip.node.id !== from && chip.node.id !== to) {
                expect(Math.abs(x1 + (x2 - x1) * t - chip.x) < 116 && Math.abs(y1 + (y2 - y1) * t - chip.y) < 26, `${id} through ${chip.node.id}`).toBe(false);
            }
        }
        const bands = bandsOf(after);
        for (const [i, band] of bands.entries()) if (i) expect(band.bottom, `L${band.level}`).toBe(bands[i - 1].top);
        for (const p of chips) {
            const band = bands.find(b => b.level === p.node.level)!;
            expect(p.y - 26 > band.top && p.y + 26 < band.bottom, p.node.id).toBe(true);
        }
        for (const a of chips) for (const b of chips) if (a !== b && Math.abs(a.y - b.y) < 60 && a.x <= b.x) expect(b.x - a.x, `${a.node.id} and ${b.node.id}`).toBeGreaterThanOrEqual(240);
        const routed = [...traces(after, () => 26)].map(([id, points]) => ({ id, net: id.slice(0, id.lastIndexOf('/')), parts: points.slice(1).map((to, i) => [points[i], to]).filter(([from, to]) => from[0] !== to[0] || from[1] !== to[1]) }));
        expect(routed.length).toBe(chips.filter(p => p.node.side).length);
        for (const { id, net, parts } of routed) {
            const samples = parts.flatMap(([[x1, y1], [x2, y2]]) => [0.25, 0.5, 0.75].map(t => [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t]));
            for (const p of chips) if (p.node.id !== id && p.node.id !== net) for (const [x, y] of samples) expect(Math.abs(x - p.x) < 116 && Math.abs(y - p.y) < 26, `${id} through ${p.node.id}`).toBe(false);
        }
        // two traces run along the same stretch only as one net: from the same node on the same side
        const runs = [...routed.map(r => ({ net: `${r.net} ${after.find(p => p.node.id === r.id)!.node.side}`, parts: r.parts })), ...joined.map(j => ({ net: `${j.from} ${j.points[1][1] < j.points[0][1] ? 'up' : 'down'}`, parts: j.points.slice(1).map((to, i) => [j.points[i], to]) }))]
            .flatMap(r => r.parts.filter(([a, b]) => a[0] === b[0] || a[1] === b[1]).map(([a, b]) => ({ net: r.net, upright: a[0] === b[0], at: a[0] === b[0] ? a[0] : a[1], lo: Math.min(a[0] === b[0] ? a[1] : a[0], a[0] === b[0] ? b[1] : b[0]), hi: Math.max(a[0] === b[0] ? a[1] : a[0], a[0] === b[0] ? b[1] : b[0]) })));
        for (const a of runs) for (const b of runs) if (a.net < b.net && a.upright === b.upright && Math.abs(a.at - b.at) < 3) expect(Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo), `${a.net} along ${b.net}`).toBeLessThanOrEqual(0);
        if (lens === 'domain') expect(after.length).toBeGreaterThan(20);
    }
});

test('equally relevant nodes stand in the order of their names, whatever the order of the source', async () => {
    const module = (members: string[]) => `module m {\n${members.map(name => `  entity ${name} {\n    label: String\n  }\n`).join('')}}\n`;
    const labels = async (members: string[]) => growTree(await indexOf({ 'm.appling': module(members) }), DOMAIN, new Set(['~', '~/m'])).children![0].children!.map(c => c.label);
    expect(await labels(['Cherry', 'Apple', 'Banana'])).toEqual(['Apple', 'Banana', 'Cherry']);
    expect(await labels(['Banana', 'Cherry', 'Apple'])).toEqual(['Apple', 'Banana', 'Cherry']);
});

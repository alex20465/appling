import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import type { Model } from '@appling/lang';
import { buildGraph, diffGraphs, Simulator, withRemoved } from '@appling/model';
import { buildWorkspace, examples } from '../../lang/test/workspace.js';
import { bandsOf, layoutFlow, layoutStates, layoutTree, layoutUseCases } from '../src/layout.js';
import { joins, loads, sproutDelays, traces } from '../src/canvas/plant.js';
import {
    abilities, actionSummary, anchorOf, cardView, changeMarks, elementAt, implementationMarks, sessionMarks, entityActions, factOf, flowView, GraphIndex, growTree, lensOf, linked, modelPulse, peers, policyText, relations, revealPath, screenFlow, sideId, trailOf, useCaseDiagram, viewFor,
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
        '    L1 Order 14↑ 0↓',
        '      L2 Cancel 5↑ 0↓ also sales.Checkout, sales.CancelOrder, crm.Clerk',
        '        L4 Orders 4↑ 0↓',
        '        L4 OrderDetail 4↑ 0↓',
        '      L2 PlaceOrder 5↑ 0↓',
        '      L2 PaymentReceived 1↑ 0↓',
        '      L2 OrderPlaced 0↑ 0↓',
        '      L2 OrderFlow 0↑ 0↓',
        '      L2 ExpireDrafts 0↑ 0↓',
        '      L3 Checkout 2↑ 0↓',
        '      L3 CancelOrder 1↑ 0↓',
        '      L3 OpenOrders 2↑ 0↓',
        '      L3 OrdersOf 1↑ 0↓',
        '      L3 OrderSummary 3↑ 0↓',
        '      L5 crm.Clerk 0↑ 0↓',
        '      L5 Customer 0↑ 0↓',
        '      L5 Shopper 0↑ 0↓',
        '    L1 Line 0↑ 0↓',
        '    L1 OrderStatus 2↑ 0↓',
        '  crm (3)'
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
    expect(names('crm.Clerk', 'down')).toEqual([
        'crm.Account', 'crm.ConvertFlow', 'crm.FollowUp', 'crm.Lead', 'crm.LeadDetail', 'crm.Leads', 'sales.CancelOrder', 'sales.Order', 'sales.OrderDetail', 'sales.Orders', 'sales.PublicApi'
    ]);
    expect(names('crm.Employee', 'down')).toEqual(['crm.ConvertFlow', 'crm.LeadDetail', 'crm.Leads', 'sales.OrderDetail', 'sales.Orders', 'sales.PublicApi']);
    expect(names('sales.Orders', 'up')).toEqual(['crm.Clerk', 'crm.Employee', 'sales.Customer', 'sales.Shopper']);
    expect(names('sales.Orders', 'down')).toEqual(['sales.Cancel', 'sales.OpenOrders', 'sales.OrderSummary']);
    expect(peers(index, 'sales.Order.customer').sort()).toEqual(['crm.Account', 'sales.Line', 'sales.OrderStatus']);
    expect(peers(index, 'crm.Clerk')).toEqual(['crm.Employee']);
});

test('an empty module shows on every level', async () => {
    const index = await indexOf({ ...examples(), 'billing.appling': 'module billing {\n}\n', 'tags.appling': 'module tags {\n  entity Tag {\n    label: String\n  }\n}\n' });
    const open = new Set(['~', '~/billing']);
    const behavior = growTree(index, { ...DOMAIN, lens: 'behavior' }, open);
    expect(behavior.children!.find(m => m.label === 'billing')).toMatchObject({ fact: 'empty', count: 0 });
    // a module with declarations, none of them on this level, is left out
    expect(behavior.children!.map(m => m.label)).not.toContain('tags');
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
    expect(cancel.links).toEqual(['sales.Checkout', 'sales.CancelOrder', 'crm.Clerk']);
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
        application: ['sales.OpenOrders', 'sales.OrdersOf', 'sales.OrderSummary', 'sales.Checkout', 'sales.CancelOrder'],
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
        ['crm.Leads', 'no', ['crm.Contact no', 'crm.Lose no']],
        ['crm.LeadDetail', 'no', ['crm.Win no', 'crm.Lose no']],
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
}, 30_000);

test('equally relevant nodes stand in the order of their names, whatever the order of the source', async () => {
    const module = (members: string[]) => `module m {\n${members.map(name => `  entity ${name} {\n    label: String\n  }\n`).join('')}}\n`;
    const labels = async (members: string[]) => growTree(await indexOf({ 'm.appling': module(members) }), DOMAIN, new Set(['~', '~/m'])).children![0].children!.map(c => c.label);
    expect(await labels(['Cherry', 'Apple', 'Banana'])).toEqual(['Apple', 'Banana', 'Cherry']);
    expect(await labels(['Banana', 'Cherry', 'Apple'])).toEqual(['Apple', 'Banana', 'Cherry']);
});

const SHOP = `module shop {
  role Buyer
  role Staff
  actor human Customer roles Buyer
  actor human Clerk roles Staff
  actor system Robot

  entity Cart {
    owner: String
    policy read { actor.is(Buyer) || actor.is(Staff) }
    policy update { actor.is(Buyer) || actor.is(Staff) }
  }
  entity Invoice {
    total: Int
    policy read { actor.is(Staff) }
  }

  action Pay on Cart {
    input {
      card: String
    }
    policy { actor.is(Buyer) }
  }
  action Refund on Cart {
    policy { actor.is(Staff) }
  }

  query Carts from Cart {
    where { owner != "" }
  }
  query Invoices from Invoice {
    where { total > 0 }
  }
  projection CartRow from Cart {
    owner
  }
  projection InvoiceRow from Invoice {
    total
  }

  usecase Checkout (cart: Cart) by Buyer {
    step Pay(cart)
    step Notify(cart)
  }
  usecase Notify (cart: Cart) by Robot {
    step Refund(cart)
  }
  usecase Audit by Clerk {
    step Invoices()
  }

  page CartList route "/carts" {
    list Carts as CartRow { owner } actions Pay, Refund
  }
  page PayPage route "/pay" {
    detail CartRow
    form Pay
  }
  page Books route "/books" {
    list Invoices as InvoiceRow
  }
  page Hidden route "/hidden" {
    list Invoices as InvoiceRow
  }

  navigation Main {
    "Carts" -> CartList {
      "Books" -> Books
    }
  }

  flow Buying for Checkout { CartList -> PayPage }
}
`;

test('the use case diagram draws the declared actors, who starts which use case, and «include» of what the steps call', async () => {
    const diagram = useCaseDiagram(await indexOf({ 'shop.appling': SHOP }));
    expect(diagram.actors.map(a => a.label).sort()).toEqual(['Clerk', 'Customer', 'Robot']);
    // the actions the steps call follow the use cases as subfunctions; a query a step calls is no use case
    expect(diagram.useCases.map(u => `${u.label}${u.subfunction ? ' (subfunction)' : ''}`).sort()).toEqual(['Audit', 'Checkout', 'Notify', 'Pay (subfunction)', 'Refund (subfunction)']);
    // a role after `by` associates the actors that hold it, an actor only itself
    expect(diagram.associations).toEqual(expect.arrayContaining([{ actor: 'shop.Customer', useCase: 'shop.Checkout' }, { actor: 'shop.Clerk', useCase: 'shop.Audit' }, { actor: 'shop.Robot', useCase: 'shop.Notify' }]));
    expect(diagram.associations).toHaveLength(3);
    expect(diagram.includes).toEqual(expect.arrayContaining([
        { from: 'shop.Checkout', to: 'shop.Pay' }, { from: 'shop.Checkout', to: 'shop.Notify' }, { from: 'shop.Notify', to: 'shop.Refund' }
    ]));
    expect(diagram.includes).toHaveLength(3);

    const placed = layoutUseCases(diagram);
    const at = (qn: string) => placed.useCases.find(u => u.qn === qn)!;
    // an included use case stands right below the one that includes it, subfunctions to the right
    expect(at('shop.Notify').y - at('shop.Checkout').y).toBe(100);
    expect(at('shop.Pay').x).toBeGreaterThan(at('shop.Checkout').x);
    for (const u of placed.useCases) {
        expect(u.x - u.w).toBeGreaterThan(placed.boundary.x);
        expect(u.x + u.w).toBeLessThan(placed.boundary.x + placed.boundary.width);
        expect(u.y + u.h).toBeLessThan(placed.boundary.y + placed.boundary.height);
    }
    for (const a of placed.actors) expect(a.x + a.w).toBeLessThan(placed.boundary.x);
    // an actor stands beside the use case it starts, and its curve runs through no other chip
    expect(placed.actors.find(a => a.qn === 'shop.Customer')!.y).toBe(at('shop.Checkout').y);
    for (const line of placed.associations) for (const u of placed.useCases.filter(u => u.qn !== line.useCase)) {
        const [[x1, y1], [x2, y2]] = [line.from, line.to];
        for (const t of [0.25, 0.5, 0.75, 0.95]) {
            // the curve leaves and enters horizontally, its control points halfway between the ends
            const mx = (x1 + x2) / 2;
            const x = (1 - t) ** 3 * x1 + 3 * (1 - t) ** 2 * t * mx + 3 * (1 - t) * t * t * mx + t ** 3 * x2;
            const y = y1 + (y2 - y1) * (3 * t * t - 2 * t * t * t);
            expect(Math.abs(x - u.x) < u.w && Math.abs(y - u.y) < u.h, `${line.actor} to ${line.useCase} through ${u.qn}`).toBe(false);
        }
    }
});

test('a state diagram stands the initial state on top under its pseudostate and keeps the states apart', async () => {
    const index = await indexOf(examples());
    const placed = layoutStates(flowView(index, 'machine', ['sales.OrderFlow']));
    const at = (name: string) => placed.nodes.find(n => n.node.label === name)!;
    expect(placed.initial!.x).toBe(at('draft').x);
    expect(placed.initial!.y).toBeLessThan(at('draft').y);
    for (const a of placed.nodes) for (const b of placed.nodes) if (a !== b) {
        expect(Math.abs(a.x - b.x) >= (a.width + b.width) / 2 + 100 || Math.abs(a.y - b.y) >= 140, `${a.node.label} and ${b.node.label}`).toBe(true);
    }
    // the two transitions into cancelled and the one into paid get labels of their own
    const labels = placed.edges.map(e => [e.x, e.y]);
    for (const [i, [x1, y1]] of labels.entries()) for (const [x2, y2] of labels.slice(i + 1)) expect(Math.hypot(x1 - x2, y1 - y2)).toBeGreaterThan(40);
});

test('the screen flow of an actor holds the pages it may use, with only its actions, the menu cut to them and the steps of a flow', async () => {
    const index = await indexOf({ 'shop.appling': SHOP });
    const customer = screenFlow(index, 'shop.Customer');
    expect(customer.screens.map(s => s.label)).toEqual(['CartList', 'PayPage']);
    // a row of the cart list opens the page that details carts
    expect(customer.screens[0].parts).toEqual([{ kind: 'list', query: 'shop.Carts', projection: 'shop.CartRow', submits: undefined, fields: ['owner'], actions: ['shop.Pay'], opens: 'shop.PayPage' }]);
    expect(customer.screens[1].parts.map(p => [p.kind, p.fields])).toEqual([['detail', ['owner']], ['form', ['card']]]);
    expect(customer.screens.map(s => s.flows)).toEqual([
        [{ flow: 'shop.Buying', label: 'Checkout', step: 1, of: 2, next: 'shop.PayPage' }],
        [{ flow: 'shop.Buying', label: 'Checkout', step: 2, of: 2, next: undefined }]
    ]);
    // PayPage is reached through the flow and the rows, so it needs no menu of its own
    expect(customer.menus).toEqual([{ qn: 'shop.Main', label: 'Main', items: [{ label: 'Carts', page: 'shop.CartList', children: [] }] }]);

    const clerk = screenFlow(index, 'shop.Clerk');
    expect(clerk.screens.map(s => s.label)).toEqual(['CartList', 'PayPage', 'Books', 'Hidden']);
    expect(clerk.screens[0].parts[0].actions).toEqual(['shop.Refund']);
    // a form the actor may not submit is left out, and so is the flow of a use case it does not start
    expect(clerk.screens[1].parts.map(p => p.kind)).toEqual(['detail']);
    expect(clerk.screens[0].flows).toEqual([]);
    expect(clerk.menus[0].items[0].children).toEqual([{ label: 'Books', page: 'shop.Books', children: [] }]);
    // a page that nothing leads to stands under More
    expect(clerk.menus.at(-1)).toEqual({ label: 'More', items: [{ label: 'Hidden', page: 'shop.Hidden', children: [] }] });

    expect(screenFlow(index, 'shop.Robot').screens).toEqual([]);
});

test('a state diagram of a machine with many transitions runs top down, with rollbacks and hubs as bundles', async () => {
    const index = await indexOf({ 'quotes.appling': readFileSync(new URL('./fixtures/quotes.appling', import.meta.url), 'utf8') });
    const placed = layoutStates(flowView(index, 'machine', ['quotes.QuoteLifecycle']));
    const y = (state: string) => placed.nodes.find(n => n.node.label === state)!.y;
    // the initial state on top, the states nothing leaves at the bottom
    expect(y('new')).toBe(Math.min(...placed.nodes.map(n => n.y)));
    expect([y('archived'), y('confirmed')]).toEqual(Array(2).fill(Math.max(...placed.nodes.map(n => n.y))));
    // the order of the business: prepared, sent, opened, accepted
    expect(['new', 'draft', 'sent', 'opened', 'accepted'].map(y)).toEqual(['new', 'draft', 'sent', 'opened', 'accepted'].map(y).sort((a, b) => a - b));
    // a state that most others lead to stands below them, not in the middle
    expect(y('cancelled')).toBeGreaterThan(y('accepted'));
    // Cancel from nine states is one arrow, and so is the rollback into each state
    const bundles = placed.edges.filter(e => e.bundle);
    expect(bundles.map(e => e.edge.label)).toContain('Cancel · from 9 states');
    expect(bundles.find(e => e.edge.label === 'Cancel · from 9 states')!.edge.title).toBe('new, draft, waiting, pending, sent, opened, accepted, unavailable, rejected');
    const curves = placed.edges.filter(e => !e.bundle);
    expect(curves.some(e => e.edge.label?.includes('FailTransition'))).toBe(false);
    expect(curves.length).toBeLessThan(25);
    // no two states overlap
    for (const a of placed.nodes) for (const b of placed.nodes) if (a !== b && a.y === b.y) expect(Math.abs(a.x - b.x)).toBeGreaterThanOrEqual((a.width + b.width) / 2);
});

const ADMIN = `module app {
  actor human Admin
  entity User core { name: String  policy read, update { actor.is(Admin) } }
  entity Token internal { hash: String  policy read { actor.is(Admin) } }
  action Rename on User { input { name: String } effect { set name = name } policy { actor.is(Admin) } }
  action Block on User { policy { actor.is(Admin) } }
  action Unblock on User { policy { actor.is(Admin) } }
  action Promote on User { policy { actor.is(Admin) } }
  action Demote on User { policy { actor.is(Admin) } }
  query Users from User { }
  query Tokens from Token { }
  projection UserRow from User { name }
  projection TokenRow from Token { hash }
  usecase Onboard (user: User) by Admin core { step "welcome the user" step Rename(user, "new") }
  usecase Rotate (token: Token) by Admin internal { step "replace the token" }
  page Home route "/" core { list Users as UserRow }
  page Admin route "/admin" core { list Users as UserRow }
  page AdminUsers route "/admin/users" core { list Users as UserRow }
  page AdminUser route "/admin/users/{id}/roles" core { detail UserRow actions Rename, Block, Unblock, Promote, Demote }
  page AdminAudit route "/admin/users/audit" core { list Users as UserRow }
  page AdminTokens route "/admin/tokens" internal { list Tokens as TokenRow }
  navigation Main { "Home" -> Home "Admin" -> Admin }
}`;

test('a page nothing leads to stands below the page its route lies under', async () => {
    const flow = screenFlow(await indexOf({ 'app.appling': ADMIN }), 'app.Admin');
    const admin = flow.menus[0].items[1];
    expect(admin.children.map(c => c.label)).toEqual(['AdminUsers', 'AdminTokens']);
    // a third level; the page a row opens needs no item of its own
    expect(admin.children[0].children).toEqual([{ label: 'AdminAudit', page: 'app.AdminAudit', children: [] }]);
    expect(flow.menus).toHaveLength(1);
});

test('the views draw down to a relevance level, and everything without one', async () => {
    const index = await indexOf({ 'app.appling': ADMIN });
    expect(useCaseDiagram(index).useCases.map(u => u.label)).toEqual(expect.arrayContaining(['Onboard', 'Rotate']));
    const core = useCaseDiagram(index, 'core');
    expect(core.useCases.map(u => u.label)).toEqual(['Onboard']);
    // the actor that starts a drawn use case is drawn whatever its own relevance
    expect(core.associations).toEqual([{ actor: 'app.Admin', useCase: 'app.Onboard' }]);
    expect(screenFlow(index, 'app.Admin', 'core').screens.map(s => s.label)).not.toContain('AdminTokens');
    const entities = (relevance?: 'core') => growTree(index, { ...DOMAIN, relevance }, new Set(['~', '~/app'])).children![0].children!.map(c => c.label);
    expect(entities()).toEqual(['User', 'Token']);
    expect(entities('core')).toEqual(['User']);
});

import { expect, test } from 'vitest';
import type { Model } from '@appling/lang';
import { buildGraph, Simulator } from '@appling/model';
import { buildWorkspace, examples } from '../../lang/test/workspace.js';
import { abilities, actionSummary, cardView, elementAt, entityActions, factOf, GraphIndex, growTree, policyText, relations, revealPath, search, viewFor, type Card, type TreeNode } from '../src/views.js';

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

/** Each node as `label (count)`, with its children indented below it. */
const outline = (node: TreeNode, depth = 0): string[] => [`${'  '.repeat(depth)}${node.label} (${node.count})`, ...(node.children ?? []).flatMap(c => outline(c, depth + 1))];

test('the tree starts folded at the seed and unfolds modules, then the lens declarations, then what uses them, by kind', async () => {
    const index = await indexOf(examples());
    expect(outline(growTree(index, DOMAIN, new Set(), 'shop'))).toEqual(['shop (2)']);
    const open = new Set(['~', '~/sales', '~/sales/#Entity', '~/sales/#Entity/sales.Order', '~/sales/#Entity/sales.Order/#Action']);
    expect(outline(growTree(index, DOMAIN, open))).toEqual([
        'model (2)',
        '  sales (3)',
        '    Entities (1)',
        '      Order (9)',
        '        Actions (2)',
        '          PlaceOrder (4)',
        '          Cancel (5)',
        '        Use cases (1)',
        '        Machines (1)',
        '        Projections (1)',
        '        Queries (1)',
        '        Events (2)',
        '        Jobs (1)',
        '    Enums (1)',
        '    Value types (1)',
        '  crm (1)'
    ]);
    expect(growTree(index, DOMAIN, open).children!.find(m => m.label === 'sales')!.fact).toBe('1 entity · 1 value · 1 enum');
});

test('a declaration that is already on its branch does not unfold again', async () => {
    const index = await indexOf({ 'a.appling': 'module a {\n  entity Node {\n    parent: Node?\n    owner: Owner\n  }\n  entity Owner {\n    nodes: Node[]\n  }\n}\n' });
    const open = new Set(['~', '~/a', '~/a/a.Owner', '~/a/a.Owner/a.Node']);
    const owner = growTree(index, DOMAIN, open).children![0].children!.find(n => n.qn === 'a.Owner')!;
    expect(owner.children!.map(n => n.qn)).toEqual(['a.Node']);
    expect(owner.children![0].children!.map(n => [n.qn, n.cycle, n.count])).toEqual([['a.Owner', true, 0]]);
});

test('facts say what a declaration is about, and a selection reveals its declaration in the lens that has it', async () => {
    const index = await indexOf(examples());
    const fact = (qn: string) => factOf(index, index.nodes.get(qn)!);
    expect(fact('sales.Order')).toBe('8 fields · 2 actions on it');
    expect(fact('sales.Cancel')).toBe('on Order · draft, placed → cancelled');
    expect(fact('sales.OrderFlow')).toBe('on Order.status · 4 states');
    expect(fact('sales.ExpireDrafts')).toBe('every 0 3 * * * · runs Cancel');
    expect(fact('sales.OpenOrders')).toBe('from Order');
    expect(revealPath(index, { ...DOMAIN, lens: 'behavior' }, 'sales.PlaceOrder.EmptyOrder')).toEqual(['~', '~/sales', '~/sales/#Action']);
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

test('search finds elements of the chosen layers by name or kind', async () => {
    const index = await indexOf(examples());
    const all = ['domain', 'behavior', 'application', 'interface', 'experience', 'cross'];
    expect(search(index, 'placeorder', all).map(n => n.qn)).toEqual([
        'sales.PlaceOrder', 'sales.PlaceOrder.effect[set placed_at]', 'sales.PlaceOrder.EmptyOrder', 'sales.PlaceOrder.policy[]'
    ]);
    expect(search(index, 'machine', all).map(n => n.qn)).toEqual(['sales.OrderFlow']);
    expect(search(index, 'order', ['experience']).map(n => n.qn)).toEqual(['sales.Orders', 'sales.OrderDetail']);
    expect(search(index, '', ['domain']).map(n => n.qn)).toEqual(['crm.Account', 'sales.OrderStatus', 'sales.Line', 'sales.Order']);
});

test('relations lift members to declarations and group them by layer', async () => {
    const index = await indexOf(examples());
    const grouped = (qn: string, direction: 'uses' | 'usedBy') => Object.fromEntries([...relations(index, qn, direction)].map(([l, r]) => [l, r.map(x => x.qn)]));
    const via = (qn: string, direction: 'uses' | 'usedBy') => Object.fromEntries([...relations(index, qn, direction).values()].flat().map(r => [r.qn, r.via]));
    expect(grouped('sales.Order', 'usedBy')).toEqual({
        behavior: ['sales.OrderPlaced', 'sales.PaymentReceived', 'sales.PlaceOrder', 'sales.Cancel', 'sales.OrderFlow', 'sales.ExpireDrafts'],
        application: ['sales.OpenOrders', 'sales.OrderSummary', 'sales.Checkout']
    });
    expect(grouped('sales.Order', 'uses')).toEqual({ domain: ['crm.Account', 'sales.Line', 'sales.OrderStatus'], cross: ['crm.Clerk', 'sales.Customer', 'sales.Shopper'] });
    expect(via('sales.Order.placed_at', 'usedBy')).toEqual({ 'sales.PlaceOrder': ['effect[set placed_at]'], 'sales.OpenOrders': [] });
    expect(via('sales.Order', 'uses')['crm.Account']).toEqual(['customer']);
    expect(via('sales.PlaceOrder', 'usedBy')).toMatchObject({ 'sales.OrderFlow': ['transition[draft->placed]'], 'sales.PublicApi': ['endpoint[POST /orders/{id}/place]'] });
    expect(grouped('sales.PlaceOrder', 'usedBy')).toEqual({
        behavior: ['sales.OrderFlow'], application: ['sales.Checkout'], interface: ['sales.PublicApi'], experience: ['sales.OrderDetail']
    });
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
        ['sales.OrderDetail', 'depends', ['sales.PlaceOrder no', 'sales.Cancel no']]
    ]);
    expect(policyText(index, 'sales.Order.policy[read]')).toBe('Order policy[read]: actor.is(crm.Clerk) || (actor.is(Customer) && customer == actor.account)');
    expect(policyText(index, 'sales.PlaceOrder.policy[]')).toBe('PlaceOrder policy: actor.is(Customer) && customer == actor.account');
});

const text = (cards: Card[]) => cards.map(card => ({
    title: `${card.title}${card.tag ? ` (${card.tag})` : ''}`,
    sections: card.sections.map(s => `${s.title ?? ''}: ${s.rows.map(r => `${r.text}${r.note ? ` [${r.note}]` : ''}`).join('; ')}`)
}));

test('a machine view is one card per state with what can be done there', async () => {
    const cards = cardView(await indexOf(examples()), 'machine', ['sales.OrderFlow']);
    expect(text(cards)).toEqual([
        { title: 'draft (initial)', sections: [': PlaceOrder → placed; Cancel → cancelled [when !has(paid_at) · job ExpireDrafts]'] },
        { title: 'placed', sections: [': on PaymentReceived → paid; Cancel → cancelled [when !has(paid_at)]'] },
        { title: 'paid (final)', sections: [] },
        { title: 'cancelled (final)', sections: [] }
    ]);
    expect(cards[0].sections[0].rows.map(r => r.qn)).toEqual(['sales.PlaceOrder', 'sales.Cancel']);
});

test('one action of several targets is one option per state', async () => {
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
    expect(text(cardView(index, 'machine', ['m.F']))[0].sections).toEqual([': Go → b, c']);
});

test('an action card says between which states it moves, who may run it and what it requires and changes', async () => {
    const cards = cardView(await indexOf(examples()), 'action', ['sales.PlaceOrder']);
    expect(text(cards)).toEqual([{
        title: 'PlaceOrder (on Order)',
        sections: [
            'States: draft → placed', 'Who: Shopper: no', 'Requires: requires { lines.size() > 0 } else EmptyOrder',
            'Changes: set placed_at = now; emit OrderPlaced { order = this }', 'Errors: EmptyOrder',
            'Used by: Checkout [usecase]; PublicApi [interface]; OrderDetail [page]'
        ]
    }]);
});

test('use case and event cards list steps, emitters and consumers', async () => {
    const index = await indexOf(examples());
    expect(text(cardView(index, 'usecase', ['sales.Checkout']))[0].sections).toEqual([
        'Inputs: order: Order',
        'Steps: 1. step PlaceOrder(order); 2. step Payments.Charge(order.total) on Declined do Cancel(order); 3. await PaymentReceived timeout "24h" do Cancel(order)',
        'Used by: CheckoutFlow [flow]'
    ]);
    expect(text(cardView(index, 'event', ['sales.OrderPlaced', 'sales.PaymentReceived']))).toEqual([
        { title: 'OrderPlaced (event)', sections: ['Fields: order: Order', 'Emitted by: PlaceOrder'] },
        { title: 'PaymentReceived (event)', sections: ['Fields: order: Order', 'Triggers: OrderFlow: placed → paid', 'Resumes: Checkout'] }
    ]);
    expect([viewFor('Machine'), viewFor('Module'), viewFor('Field')]).toEqual(['machine', 'entities', undefined]);
});

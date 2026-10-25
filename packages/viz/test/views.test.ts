import { expect, test } from 'vitest';
import type { Model } from '@appling/lang';
import { buildGraph, Simulator } from '@appling/model';
import { buildWorkspace, examples } from '../../lang/test/workspace.js';
import { abilities, actionSummary, cardView, elementAt, entityActions, entityView, GraphIndex, policyText, relations, search, shownFor, viewFor, type Card } from '../src/views.js';

const HIDE = { linkEntities: false, emptyModules: false };
const SHOW = { linkEntities: true, emptyModules: true };

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

test('the entity view shows modules, entities and the associations between entities only', async () => {
    const view = entityView(await indexOf(examples()), HIDE);
    expect(view.modules).toEqual([{ qn: 'crm', parent: undefined }, { qn: 'sales', parent: undefined }]);
    expect(view.entities.map(e => [e.qn, e.actions])).toEqual([['crm.Account', 0], ['sales.Order', 2]]);
    expect(view.associations).toEqual([{ id: 'sales.Order>crm.Account', from: 'sales.Order', to: 'crm.Account', label: 'customer' }]);
});

test('link entities are hidden unless asked for', async () => {
    const index = await indexOf({ 'c.appling': CATALOG });
    const hidden = entityView(index, HIDE);
    expect(hidden.entities.map(e => e.qn)).toEqual(['catalog.Product', 'catalog.Tag']);
    expect(hidden.associations).toEqual([]);
    const shown = entityView(index, SHOW);
    expect(shown.entities.find(e => e.qn === 'catalog.ProductTag')).toMatchObject({ name: 'ProductTag', link: true });
    expect(shown.associations.map(a => `${a.id} ${a.label}`)).toEqual([
        'catalog.Product>catalog.ProductTag tags[]', 'catalog.ProductTag>catalog.Product product', 'catalog.ProductTag>catalog.Tag tag?'
    ]);
});

test('modules without shown entities are hidden unless asked for', async () => {
    const index = await indexOf({ 'a.appling': 'module a {\n  module b {\n    entity X {\n      n: Int\n    }\n  }\n}\nmodule empty {\n  role R\n}\n' });
    expect(entityView(index, HIDE).modules.map(m => m.qn)).toEqual(['a', 'a.b']);
    expect(entityView(index, SHOW).modules.map(m => m.qn)).toEqual(['a', 'a.b', 'empty']);
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

test('a selection maps to the entity or module shown for it', async () => {
    const index = await indexOf(examples());
    const view = entityView(index, HIDE);
    expect(shownFor('sales.Order.status', view, index)).toBe('sales.Order');
    expect(shownFor('sales.PlaceOrder', view, index)).toBe('sales');
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
    expect(grouped('sales.Order', 'uses')).toEqual({ domain: ['crm.Account', 'sales.Line', 'sales.OrderStatus'], cross: ['crm.Clerk', 'sales.Shopper'] });
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
    expect(policyText(index, 'sales.Order.policy[read]')).toBe('Order policy[read]: actor.is(crm.Clerk) || customer == actor.account');
    expect(policyText(index, 'sales.PlaceOrder.policy[]')).toBe('PlaceOrder policy: actor.is(Customer) && customer == actor.account');
});

const text = (cards: Card[]) => cards.map(card => ({
    title: `${card.title}${card.tag ? ` (${card.tag})` : ''}`,
    sections: card.sections.map(s => `${s.title ?? ''}: ${s.rows.map(r => `${r.text}${r.note ? ` [${r.note}]` : ''}`).join('; ')}`)
}));

test('a focused entity view keeps the focused entities, their neighbours and their modules', async () => {
    const view = entityView(await indexOf(examples()), { ...HIDE, focus: ['crm.Account'] });
    expect(view.entities.map(e => e.qn)).toEqual(['crm.Account', 'sales.Order']);
    expect(view.modules.map(m => m.qn)).toEqual(['crm', 'sales']);
    expect(view.associations.map(a => a.id)).toEqual(['sales.Order>crm.Account']);
});

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

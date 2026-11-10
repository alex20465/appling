import { expect, test } from 'vitest';
import type { Model } from '@appling/lang';
import { buildWorkspace, examples } from '../../lang/test/workspace.js';
import { buildGraph, Simulator, UNKNOWN, type ExprData } from '../src/index.js';

async function simulator(sources: Record<string, string>) {
    const { documents, services } = await buildWorkspace(sources);
    return new Simulator(buildGraph(documents.map(d => d.parseResult.value as Model), services), new Date('2026-10-23T10:00:00Z'));
}

test('reachability follows transitions from the initial state', async () => {
    const sim = await simulator(examples());
    expect(sim.reach('sales.OrderFlow', 'paid')).toEqual({
        from: 'draft',
        path: [
            { transition: 'sales.OrderFlow.transition[draft->placed]', trigger: 'PlaceOrder', to: 'placed', guarded: false },
            { transition: 'sales.OrderFlow.transition[placed->paid]', trigger: 'PaymentReceived', to: 'paid', guarded: false }
        ]
    });
    expect(sim.reach('sales.OrderFlow', 'draft')?.path).toEqual([]);
});

test('a timed transition moves a record once its duration passed since the date, and reachability follows it', async () => {
    const sim = await simulator({ 'm.appling': `module m {
      enum S { open held closed }
      entity Ticket {
        status: S state default open
        points: Int default 0
        opened_at: DateTime default now
        held_at: DateTime?
        note: String?
        invariant "noted when closed" { status != closed || has(note) }
      }
      machine Flow on Ticket.status {
        transition open -> closed after "48h" since opened_at when { points < 5 } effect { set note = "expired" }
        transition held -> open after "1h" since held_at
      }
    }` });
    expect(sim.reach('m.Flow', 'closed')?.path).toEqual([{ transition: 'm.Flow.transition[open->closed]', trigger: 'after 48h', to: 'closed', guarded: true }]);
    // The clock is 2026-10-23T10:00Z.
    const due = sim.elapse('m.Flow', { status: 'open', points: 1, opened_at: new Date('2026-10-21T09:59:00Z'), note: null });
    expect(due).toMatchObject({ transition: 'm.Flow.transition[open->closed]', after: { status: 'closed', note: 'expired' }, violated: [], undecided: [] });
    expect(sim.elapse('m.Flow', { status: 'open', points: 1, opened_at: new Date('2026-10-21T10:01:00Z') })).toBeUndefined();
    expect(sim.elapse('m.Flow', { status: 'open', points: 9, opened_at: new Date('2026-10-01T00:00:00Z') })).toBeUndefined();
    expect(sim.elapse('m.Flow', { status: 'closed', opened_at: new Date('2026-10-01T00:00:00Z') })).toBeUndefined();
    // An empty date never comes due; a date or guard not given leaves the answer undecided.
    expect(sim.elapse('m.Flow', { status: 'held', held_at: null })).toBeUndefined();
    expect(sim.elapse('m.Flow', { status: 'held' })?.undecided).toEqual(['the date held_at']);
    expect(sim.elapse('m.Flow', { status: 'open', opened_at: '2026-10-01T00:00:00Z' })?.undecided).toEqual(['the guard points < 5']);
});

test('reachability also starts from the states a create assigns', async () => {
    const sim = await simulator({ 'm.appling': `module m {
      enum S { open waiting done }
      entity Order { status: S state default open }
      action Close on Order { }
      action Wait { effect { create Order { status = waiting } } }
      machine Flow on Order.status { transition waiting -> done via Close }
    }` });
    expect(sim.reach('m.Flow', 'done')).toEqual({ from: 'waiting', path: [{ transition: 'm.Flow.transition[waiting->done]', trigger: 'Close', to: 'done', guarded: false }] });
});

test('actor.is(Role) holds when the actor carries the role and the role condition holds', async () => {
    const sim = await simulator({ 'ops.appling': `module ops {
      entity User {
        disabled: Bool default false
        active: Bool = !disabled
      }
      role Operator { actor.active }
      role Guest
      actor human Employee is User roles Operator
      actor human Visitor roles Guest
      entity Order { note: String? }
      action Cancel on Order {
        policy { actor.is(Operator) }
      }
    }` });
    expect(sim.actors('ops.Cancel')).toEqual([{ actor: 'ops.Employee', verdict: 'depends' }, { actor: 'ops.Visitor', verdict: 'no' }]);
    const condition = sim.graph.nodes.find(n => n.qn === 'ops.Cancel.policy[]')!.data.condition as ExprData;
    expect(sim.evaluate(condition, { actor: { actor: 'ops.Employee', fields: { disabled: false } } })).toBe(true);
    expect(sim.evaluate(condition, { actor: { actor: 'ops.Employee', fields: { disabled: true } } })).toBe(false);
});

test('actors are judged by action and entity update policies', async () => {
    const sim = await simulator(examples());
    // A clerk may update orders but not place them; a shopper may place their own draft orders, depending on the record.
    expect(sim.actors('sales.PlaceOrder')).toEqual([{ actor: 'crm.Employee', verdict: 'no' }, { actor: 'sales.Shopper', verdict: 'depends' }]);
});

test('access lists what one actor may do, with policies added up along the reference path', async () => {
    const sim = await simulator(examples());
    const access = Object.fromEntries(sim.access('sales.Shopper').map(a => [`${a.target}${a.operation ? ` ${a.operation}` : ''}${a.fields ? ` ${a.fields}` : ''}`, `${a.verdict} ${a.policies.join(' & ')}`.trim()]));
    expect(access).toMatchObject({
        'crm.Account read': 'depends crm.Account.policy[read]',
        // Nothing grants deleting an account, so nobody may.
        'crm.Account delete': 'no',
        'sales.Order read': 'depends sales.Order.policy[read]',
        'sales.Order read total': 'depends sales.Order.policy[read] & sales.Order.policy[read fields total]',
        'sales.Order update': 'depends sales.Order.policy[update]',
        'sales.PlaceOrder': 'depends sales.PlaceOrder.policy[] & sales.Order.policy[update]',
        'sales.OpenOrders': 'depends sales.Order.policy[read]',
        'sales.Checkout': 'no sales.PlaceOrder.policy[] & sales.Order.policy[update] & sales.Cancel.policy[]',
        'sales.Orders': 'depends sales.Order.policy[read]',
        'sales.OrderDetail': 'depends sales.Order.policy[read]'
    });
});

const SHOP = `module shop {
  role Clerk
  role Buyer
  actor human Staff roles Clerk
  actor human Customer roles Buyer {
    name: String
  }

  enum Status {
    open
    closed
  }

  value Line {
    amount: Money
  }

  entity Cart {
    owner: String
    status: Status state default open
    lines: Line[]
    discount: Money default 0
    total: Money = sum(lines.map(l, l.amount)) - discount
    closed_at: DateTime?

    invariant "total not negative" { total >= 0 }
  }

  event Closed {
    cart: Cart
  }

  action Close on Cart {
    input {
      discount: Money
    }
    requires { lines.size() > 0 } else Empty
    effect {
      set closed_at = now
    }
    errors Empty
    policy { actor.is(Clerk) || (actor.is(Buyer) && owner == actor.name) }
  }

  action Discount on Cart {
    input {
      amount: Money
    }
    effect {
      set discount = amount
    }
    policy { actor.is(Clerk) }
  }

  machine Flow on Cart.status {
    transition open -> closed via Close effect { emit Closed { cart = this } }
  }
}`;

test('risks are the invariants that read changed fields, also through derived fields', async () => {
    const sim = await simulator({ 'shop.appling': SHOP });
    expect(sim.risks('shop.Discount')).toEqual([{ invariant: 'shop.Cart.invariant["total not negative"]', fields: ['discount'] }]);
    expect(sim.risks('shop.Close')).toEqual([]);
});

test('running an action checks policy, preconditions and transition, applies effects and checks invariants', async () => {
    const sim = await simulator({ 'shop.appling': SHOP });
    const cart = { owner: 'ada', status: 'open', lines: [{ amount: 5 }, { amount: 7 }], discount: 0 };
    const staff = { actor: 'shop.Staff' };
    const done = sim.run('shop.Close', cart, staff, { discount: 0 });
    expect(done).toMatchObject({ allowed: 'yes', outcome: 'done', reasons: [], after: { status: 'closed', closed_at: new Date('2026-10-23T10:00:00Z') }, violated: [] });
    expect(done.events).toEqual([{ event: 'shop.Closed', fields: { cart: expect.objectContaining({ owner: 'ada' }) } }]);
    expect(sim.run('shop.Close', { ...cart, lines: [] }, staff).reasons).toEqual(['Empty']);
    expect(sim.run('shop.Close', { ...cart, status: 'closed' }, staff).reasons).toEqual(['no transition of Flow from closed']);
    expect(sim.run('shop.Close', cart, { actor: 'shop.Customer', fields: { name: 'bob' } })).toMatchObject({ allowed: 'no', outcome: 'refused' });
    expect(sim.run('shop.Close', cart, { actor: 'shop.Customer', fields: { name: 'ada' } }).allowed).toBe('yes');
    expect(sim.run('shop.Close', cart, { actor: 'shop.Customer' }).allowed).toBe('depends');
    expect(sim.run('shop.Discount', cart, staff, { amount: 20 }).violated).toEqual(['total not negative']);
});

test('unknown data stays unknown, but logic short circuits around it', async () => {
    const sim = await simulator({ 'shop.appling': SHOP });
    const invariant = (await import('../src/index.js')).buildGraph;
    expect(invariant).toBeDefined();
    const total = sim.graph.nodes.find(n => n.qn === 'shop.Cart.total')!.data.derived as never;
    expect(sim.evaluate(total, { self: { lines: [{ amount: 2 }], discount: 1 } })).toBe(1);
    expect(sim.evaluate(total, { self: {} })).toBe(UNKNOWN);
});

test('a create effect needs the created entity create policies, true allows and an undeclared actor field is null', async () => {
    const sim = await simulator({
        'desk.appling': `module desk {
  role Clerk
  actor human Staff roles Clerk {
    desk: Desk
  }
  actor human Visitor

  entity Desk {
    closed_at: DateTime?
  }

  entity Ticket {
    title: String

    policy read { true }
    policy create { actor.desk.closed_at == null && actor.desk != null }
  }

  action Open {
    input {
      title: String
    }
    effect {
      create Ticket { title = title }
    }
  }
}`
    });
    expect(sim.actors('desk.Open')).toEqual([{ actor: 'desk.Staff', verdict: 'depends' }, { actor: 'desk.Visitor', verdict: 'no' }]);
    expect(sim.access('desk.Visitor').find(a => a.target === 'desk.Ticket' && a.operation === 'read')?.verdict).toBe('yes');
});

test('a query matches a record by its filter over the inputs, an optional input left out is null', async () => {
    const sim = await simulator(examples());
    const shopper = { actor: 'sales.Shopper' };
    const account = (id: number) => ({ $type: 'crm.Account', id });
    const order = { customer: account(1), placed_at: new Date('2026-10-01T00:00:00Z') };
    expect(sim.matches('sales.OrdersOf', order, shopper, { of: account(1) })).toBe(true);
    expect(sim.matches('sales.OrdersOf', order, shopper, { of: account(2) })).toBe(false);
    expect(sim.matches('sales.OrdersOf', order, shopper, { of: account(1), since: new Date('2026-10-20T00:00:00Z') })).toBe(false);
    expect(sim.matches('sales.OrdersOf', order, shopper)).toBe(UNKNOWN);
});

const CHECKOUT = `module shop {
  entity Product { stock: Int }
  entity Order { total: Int default 0 }
  entity Item { product: Product  quantity: Int }
  entity Line { order: Order?  product: Product  quantity: Int }
  entity Cart {
    items: Item[]
    order: Order?
    count: Int default 0

    policy { true }
  }
  event CheckedOut { cart: Cart }
  action Checkout on Cart {
    effect {
      for item in items {
        create Line as line { order = order, product = item.product, quantity = item.quantity }
        update line.product {
          set stock = stock - line.quantity
        }
        set count = count + 1
        delete item
      }
      delete self
      emit CheckedOut { cart = this }
    }
  }
}`;

test('running an action loops over a collection, creates named rows, updates related records and deletes', async () => {
    const sim = await simulator({ 'shop.appling': CHECKOUT });
    const pen = { id: 1, stock: 10 };
    const cart = { id: 7, count: 0, order: null, items: [{ id: 2, product: pen, quantity: 3 }, { id: 3, product: pen, quantity: 2 }] };
    const result = sim.run('shop.Checkout', cart, { actor: 'shop.Nobody' });
    expect(result.outcome).toBe('done');
    expect(result.writes.map(w => [w.operation, w.entity, w.effect.slice('shop.Checkout.'.length)])).toEqual([
        ['create', 'shop.Line', 'effect[for item].effect[create Line]'],
        ['update', 'shop.Product', 'effect[for item].effect[update product]'],
        ['delete', 'shop.Item', 'effect[for item].effect[delete item]'],
        ['create', 'shop.Line', 'effect[for item].effect[create Line]'],
        ['update', 'shop.Product', 'effect[for item].effect[update product]'],
        ['delete', 'shop.Item', 'effect[for item].effect[delete item]'],
        ['delete', 'shop.Cart', 'effect[delete self]']
    ]);
    expect(result.writes[0].record).toEqual({ $type: 'shop.Line', order: null, product: { id: 1, stock: 10 }, quantity: 3 });
    expect(result.writes[4].record).toEqual({ id: 1, stock: 5 });
    expect(result.after).toMatchObject({ count: 2, items: [] });
    expect(result.deleted).toBe(true);
    expect(result.events).toHaveLength(1);
    // The given data stays as it was.
    expect(pen.stock).toBe(10);
    expect(cart.items).toHaveLength(2);
});

test('a collection that is not given runs no iteration, and an update of a record that is not given is unknown', async () => {
    const sim = await simulator({ 'shop.appling': CHECKOUT.replace('delete self', 'update order { set total = 1 }') });
    const result = sim.run('shop.Checkout', { id: 7 }, { actor: 'shop.Nobody' });
    expect(result.writes).toEqual([{ effect: 'shop.Checkout.effect[update order]', operation: 'update', entity: 'shop.Order', record: UNKNOWN }]);
    expect(result.deleted).toBeUndefined();
});

test('an action needs the update policies of what it updates and the delete policies of what it deletes', async () => {
    const sim = await simulator({ 'shop.appling': CHECKOUT
        .replace('entity Product { stock: Int }', 'entity Product { stock: Int  policy update { false } }')
        .replace('entity Item { product: Product  quantity: Int }', 'entity Item { product: Product  quantity: Int  policy delete { actor.is(Clerk) } }')
        .replace('module shop {', 'module shop {\n  role Clerk\n  actor human Person roles Clerk') });
    expect(sim.access('shop.Person').find(a => a.target === 'shop.Checkout')?.policies).toEqual([
        'shop.Cart.policy[]', 'shop.Product.policy[update]', 'shop.Item.policy[delete]'
    ]);
    expect(sim.actors('shop.Checkout')).toEqual([{ actor: 'shop.Person', verdict: 'no' }]);
});

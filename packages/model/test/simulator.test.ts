import { expect, test } from 'vitest';
import type { Model } from '@appling/lang';
import { buildWorkspace, examples } from '../../lang/test/workspace.js';
import { buildGraph, Simulator, UNKNOWN } from '../src/index.js';

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

test('actors are judged by action and entity update policies', async () => {
    const sim = await simulator(examples());
    // The examples restrict updates of orders to clerks, so a shopper cannot place an order: a finding for the model.
    expect(sim.actors('sales.PlaceOrder')).toEqual([{ actor: 'sales.Shopper', verdict: 'no' }]);
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
        'sales.Order update': 'no sales.Order.policy[create,update,delete]',
        'sales.PlaceOrder': 'no sales.PlaceOrder.policy[] & sales.Order.policy[create,update,delete]',
        'sales.OpenOrders': 'depends sales.Order.policy[read]',
        'sales.Checkout': 'no sales.PlaceOrder.policy[] & sales.Order.policy[create,update,delete] & sales.Cancel.policy[]',
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

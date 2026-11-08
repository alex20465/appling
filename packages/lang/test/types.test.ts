import { expect, test } from 'vitest';
import { build, errors } from './workspace.js';

const BASE = `
  role Clerk
  actor human Shopper roles Clerk {
    name: String
  }
  enum Status { open done }
  value Line {
    amount: Money
  }
  entity Order {
    status: Status state
    lines: Line[]
    total: Money = sum(lines.map(l, l.amount))
    closed_at: DateTime?
  }
  event Closed {
    order: Order
  }
  action Close on Order {
    input {
      reason: String?
    }
  }`;

async function check(members: string): Promise<string[]> {
    return errors(await build({ 'test.appling': `module m { ${BASE} ${members} }` }));
}

test('well typed expressions pass', async () => {
    expect(await check(`
      entity Note {
        text: String
        size: Int = text.size()
        invariant "short" { size < 100 && text.startsWith("n") }
        policy read { actor.is(Clerk) || actor.is(Shopper) && actor.name == text }
      }
      action Finish on Order {
        requires { status in [open, done] && lines.exists(l, l.amount > 0) } else Empty
        effect {
          set closed_at = now + duration("1h")
          emit Closed { order = this }
        }
        errors Empty
      }
      query Open from Order {
        where { status != done && total >= 0.5 }
      }
      usecase Run (order: Order) {
        step Close(order, "late")
      }`)).toEqual([]);
});

test('unknown name', async () => {
    expect(await check('entity N { invariant "x" { missing } }')).toContain('Unknown name "missing".');
});

test('unknown field', async () => {
    expect(await check('entity N { o: Order invariant "x" { o.nope == 1 } }')).toContain('Order has no field "nope".');
});

test('binary operator types', async () => {
    expect(await check('entity N { invariant "x" { "a" > 1 } }')).toContain('Operator ">" does not apply to String and Int.');
});

test('unary operator types', async () => {
    expect(await check('entity N { invariant "x" { !1 } }')).toContain('Operator "!" does not apply to Int.');
});

test('conditions are Bool', async () => {
    expect(await check('entity N { invariant "x" { 1 + 2 } }')).toContain('A condition must be Bool, not Int.');
});

test('values are assignable to their field', async () => {
    expect(await check('entity N { count: Int default "zero" }')).toContain('String is not assignable to Int.');
});

test('null only fits optional fields', async () => {
    expect(await check('entity N { count: Int default null }')).toContain('null is not assignable to Int.');
});

test('unknown function', async () => {
    expect(await check('entity N { invariant "x" { nope(1) } }')).toContain('Unknown function "nope".');
});

test('function argument types', async () => {
    expect(await check('entity N { d: Duration = duration(1) }')).toContain('duration() takes a String, not Int.');
});

test('unknown method', async () => {
    expect(await check('entity N { n: Int invariant "x" { n.upper() } }')).toContain('Int has no method "upper" for these arguments.');
});

test('actor.is takes a role or actor', async () => {
    expect(await check('entity N { policy read { actor.is(Nobody) } }')).toContain('"Nobody" is not a role or actor.');
});

test('macros take a variable and an expression', async () => {
    expect(await check('entity N { l: Int[] invariant "x" { l.exists(1) } }')).toContain('exists() takes a variable name and an expression.');
});

test('assignments name a field of the target', async () => {
    expect(await check('action Emit on Order { effect { emit Closed { nope = this } } }')).toContain('Closed has no field "nope".');
});

test('call arity', async () => {
    expect(await check('usecase U (o: Order) { step Close() }')).toContain('Close takes 1 to 2 argument(s), got 0.');
});

test('call argument types', async () => {
    expect(await check('usecase U (o: Order) { step Close(o, 5) }')).toContain('Int is not assignable to String?.');
});

test('index needs a list and an Int', async () => {
    expect(await check('entity N { l: Int[] invariant "x" { l["a"] > 0 } }')).toContain('Int[] cannot be indexed by String.');
});

test('an entity compares with the optional form of itself', async () => {
    expect(await check(`
      entity Operator { name: String }
      actor human Staff roles Clerk { operator: Operator? }
      entity Key {
        operator: Operator
        policy { actor.is(Clerk) && operator == actor.operator }
      }`)).toEqual([]);
});

test('an enum value wins over a field of the same name where the enum is expected', async () => {
    expect(await check(`
      enum Scope { operator }
      entity Operator { name: String }
      entity Key {
        operator: Operator
        scope: Scope default operator
        invariant "operator scope" { scope == operator }
      }`)).toEqual([]);
});

test('an enum value can be named with its enum', async () => {
    const sources = {
        'a.appling': 'module a { export Scope enum Scope { operator admin } entity Key { scope: Scope default Scope.operator invariant "x" { scope != a.Scope.admin } } }',
        'b.appling': 'module b { entity Grant { scope: a.Scope default a.Scope.admin } }'
    };
    expect(errors(await build(sources))).toEqual([]);
    expect(await check('entity Key { status: Status default Status.missing }')).toEqual(['Enum Status has no value "missing".']);
});

test('keywords that are names stay names before a colon and as enum values', async () => {
    expect(await check(`
      enum Theme { default migration messages limit }
      entity Chat {
        code: String unique
        state: Status state default open
        default: Theme default default
        messages: String[]
        limit: Int
      }
      action Page on Chat {
        input {
          limit: Int
        }
        requires { limit > 0 && default != migration }
      }`)).toEqual([]);
    expect(errors(await build({ 'm.appling': 'module migration { }' }))).toEqual([]);
});

test('a role holds a condition on the actor, and an actor binds to its entity', async () => {
    expect(errors(await build({ 'ops.appling': `module ops {
      entity User {
        disabled: Bool default false
        active: Bool = !disabled
      }
      role Operator { actor.active && now > actor.since }
      role Customer { actor.active }
      actor human Employee is User roles Operator {
        since: DateTime
      }
      actor human Shopper is User roles Customer
      entity Order {
        customer: User
        policy read { actor.is(Operator) || actor.is(Customer) && customer == actor }
      }
    }` }))).toEqual([]);
});

const ACTORS = `
  role Buyer
  role Seller
  entity Customer { name: String }
  entity Vendor { name: String }
  actor human Shopper roles Buyer { account: Customer }
  actor human Merchant roles Seller { account: Vendor }`;

test('actor.f declared with different types has the union of them', async () => {
    expect(errors(await build({ 'shop.appling': `module shop { ${ACTORS}
      entity Offer {
        vendor: Vendor
        customer: Customer
        label: String
        policy read { actor.is(Seller) && vendor == actor.account }
        policy update { actor.is(Buyer) && customer == actor.account }
        policy create { actor.account.name == label }
      }
    }` }))).toEqual([]);
});

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

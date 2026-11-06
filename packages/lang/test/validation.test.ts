import { expect, test } from 'vitest';
import { build, errors } from './workspace.js';

async function check(text: string): Promise<string[]> {
    return errors(await build({ 'test.appling': text }));
}

const ORDER = `
  enum Status { open done }
  entity Order {
    status: Status state
    kind: Status
    note: String
  }
  action Close on Order { }`;

test('export names an existing member', async () => {
    expect(await check('module m { export Missing }')).toContain("Could not resolve reference to Member named 'Missing'.");
    expect(await check('module m { module inner { export Outer } role Outer }')).toContain("Could not resolve reference to Member named 'Outer'.");
});

test('machine governs a state field with an enum type', async () => {
    expect(await check(`module m { ${ORDER} machine Flow on Order.kind { } }`))
        .toContain('A machine must govern an entity field marked "state" with an enum type.');
});

test('state field has one machine', async () => {
    expect(await check(`module m { ${ORDER} machine A on Order.status { } machine B on Order.status { } }`))
        .toContain('State field status is already owned by another machine.');
});

test('transition states are enum values', async () => {
    expect(await check(`module m { ${ORDER} machine Flow on Order.status { transition open -> closed via Close } }`))
        .toContain('"closed" is not a value of Status.');
});

test('set effect does not change a state field', async () => {
    expect(await check(`module m { ${ORDER} action Reopen on Order { effect { set status = open } } }`))
        .toContain('A state field changes only through a machine transition.');
});

test('operations narrow entity policies only', async () => {
    expect(await check(`module m { ${ORDER} action Edit on Order { policy read { true } } }`))
        .toContain('Operations and fields narrow entity policies only.');
});

test('projection fields exist on the source entity', async () => {
    expect(await check(`module m { ${ORDER} projection Summary from Order { missing } }`))
        .toContain('Order has no field "missing". Use "missing = <expression>" for a computed field.');
});

test('query endpoint goes through a projection', async () => {
    expect(await check(`module m { ${ORDER} query All from Order { } interface rest Api { GET "/orders" -> All } }`))
        .toContain('An endpoint exposes query results only through a projection: add "as <Projection>".');
});

test('migration renames an existing element', async () => {
    expect(await check(`module m { ${ORDER} migration One { rename Order.missing -> other } }`))
        .toContain('Module m has no element Order.other.');
});

test('migration removes an element that is gone', async () => {
    expect(await check(`module m { ${ORDER} migration One { remove Order.note } }`))
        .toContain('Removed element Order.note still exists.');
});

test('a policy grants by role', async () => {
    const warnings = async (condition: string) => (await build({ 'test.appling': `module m { role Clerk ${ORDER} action Edit on Order { policy { ${condition} } } }` }))
        .flatMap(d => d.diagnostics ?? []).filter(d => d.severity === 2).map(d => d.message);
    const message = 'A policy grants by role: every "||" branch needs actor.is(Role), or write { false }.';
    expect(await warnings('true')).toContain(message);
    expect(await warnings('!actor.is(Clerk) || note == ""')).toContain(message);
    expect(await warnings('actor.is(Clerk) || note == ""')).toContain(message);
    expect(await warnings('actor.is(Clerk) && note == ""')).toEqual([]);
    expect(await warnings('false')).toEqual([]);
});

test('does names visible elements', async () => {
    expect(await check(`module m { ${ORDER} action Edit on Order does "Edits @Order.note, not @Missing" { } }`))
        .toEqual(['Unknown element "@Missing" in does.']);
    expect(await check(`module m { ${ORDER} action Edit on Order does "Mails ops@shop.example about @Order and @Status.open." { } }`))
        .toEqual([]);
    expect(await check(`module a { export X entity X { } } module b { action Use does "Reads @a.X, not @a.Y" { } }`))
        .toEqual(['Unknown element "@a.Y" in does.']);
});

test('does names follow the layer rules', async () => {
    expect(await check(`module m { external Mail { op Send () } ${ORDER} action Edit on Order does "Calls @Mail.Send" { } }`))
        .toContain('behavior element Action may not reference application element External "@Mail.Send".');
    expect(await check(`module m { external Mail { op Send () } usecase Notify does "Calls @Mail.Send" { } }`)).toEqual([]);
});

test('a role condition reads only actor, tenant and now', async () => {
    expect(await check(`module m { ${ORDER} role Clerk { status == open } }`))
        .toContain('A role condition reads only actor, tenant and now, not "status".');
});

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

test('state field ownership is reported on every machine and not for a single one', async () => {
    const owned = 'State field status is already owned by another machine.';
    const both = await check(`module m { ${ORDER} machine A on Order.status { } machine B on Order.status { } }`);
    expect(both.filter(e => e.includes(owned))).toHaveLength(2);
    expect(await check(`module m { ${ORDER} machine A on Order.status { } }`)).not.toContain(owned);
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

test('a union of actor field types rejects what none of them fits', async () => {
    const actors = `
      role Buyer
      role Seller
      entity Customer { name: String }
      entity Vendor { name: String }
      actor human Shopper roles Buyer { account: Customer }
      actor human Merchant roles Seller { account: Vendor }`;
    const result = await check(`module shop { ${actors}
      entity Offer {
        label: String
        policy read { label == actor.account }
        policy update { actor.account.missing == label }
      }
    }`);
    expect(result).toContain('Operator "==" does not apply to String and Customer | Vendor.');
    expect(result).toContain('Customer | Vendor has no field "missing".');
});

async function warningsOf(text: string): Promise<string[]> {
    const documents = await build({ 'test.appling': text });
    return documents.flatMap(d => d.diagnostics ?? []).filter(d => d.severity === 2).map(d => d.message);
}

test('a setting or secret has a primitive type', async () => {
    expect(await check('module m { enum Region { eu us } external Mail { secret key: String[] setting region: Region op Send () } usecase U { step Mail.Send() } }'))
        .toEqual(['A secret has a primitive type, not String[].', 'A setting has a primitive type, not Region.']);
    expect(await check('module m { external Mail { secret key: String setting timeout: Duration? op Send () } usecase U { step Mail.Send() } }')).toEqual([]);
});

test('auth and interfaces name an external', async () => {
    expect(await check('module m { interface rest Api { auth bearer from Missing } }'))
        .toContain("Could not resolve reference to External named 'Missing'.");
    expect(await check('module m { query Q from Missing { } interface rest Api from Q { } }'))
        .toContain("Could not resolve reference to External named 'Q'.");
});

test('a webhook interface names its vendor and has endpoints', async () => {
    expect(await check('module m { action A { } interface webhook Events { POST "/hooks" -> A } }'))
        .toEqual(['A webhook interface names its vendor: "interface webhook Events from <External>".']);
    expect(await warningsOf('module m { external Mail { secret key: String } interface webhook Events from Mail { } }'))
        .toContain('Webhook interface Events has no endpoints.');
});

test('an external with settings or secrets is used', async () => {
    const message = 'External Mail declares settings or secrets, but nothing calls or names it.';
    expect(await warningsOf('module m { external Mail { secret key: String op Send () } }')).toContain(message);
    expect(await warningsOf('module m { external Mail { secret key: String op Send () } usecase U { step Mail.Send() } }')).not.toContain(message);
    expect(await warningsOf('module m { external Mail { secret key: String } interface rest Api { auth bearer from Mail } }')).not.toContain(message);
});

test('tenant needs exactly one tenant in the workspace', async () => {
    expect(await check(`module m { role Clerk { tenant != null } }`))
        .toContain('"tenant" needs exactly one tenant in the workspace, which declares no tenant.');
    expect(await check(`module m { entity A { } entity B { } tenant TA on A tenant TB on B ${ORDER} action Edit on Order { policy { tenant != null } } }`))
        .toContain('"tenant" needs exactly one tenant in the workspace, which declares 2 tenants.');
});

const CART = `
  entity Product { stock: Int }
  entity Item { product: Product  quantity: Int }
  entity Cart {
    items: Item[]
    tags: String[]
    owner: Product?
  }`;

test('effects loop over items, update related records, delete and name created rows', async () => {
    expect(await check(`module m { ${CART} action Checkout on Cart { effect {
        for item in items {
            create Item as copy { product = item.product, quantity = item.quantity }
            update copy.product { set stock = stock - item.quantity }
            delete item
        }
        update owner { set stock = 0 }
        delete self
    } } }`)).toEqual([]);
});

test('for iterates a collection relationship of the entity', async () => {
    expect(await check(`module m { ${CART} action A on Cart { effect { for tag in tags { } } } }`))
        .toContain('"for" iterates a collection relationship of Cart, and tags is no list of records.');
    expect(await check(`module m { ${CART} action A on Cart { effect { for item in missing { } } } }`))
        .toContain("Could not resolve reference to Field named 'missing'.");
});

test('a loop variable is visible inside its loop only', async () => {
    expect(await check(`module m { ${CART} action A on Cart { effect { for item in items { } delete item } } }`))
        .toContain('Unknown name "item".');
});

test('an as name is visible after its create only', async () => {
    expect(await check(`module m { ${CART} action A on Cart { effect { delete copy create Item as copy { quantity = 1 } } } }`))
        .toContain('Unknown name "copy".');
});

test('a loop variable or as name does not hide another name', async () => {
    const message = '"items" is already a name here; pick another one.';
    expect(await check(`module m { ${CART} action A on Cart { effect { for items in items { } } } }`)).toContain(message);
    expect(await check(`module m { ${CART} action A on Cart { effect { create Item as items { quantity = 1 } } } }`)).toContain(message);
    expect(await check(`module m { ${CART} action A on Cart { effect { for item in items { for item in items { } } } } }`))
        .toContain('"item" is already a name here; pick another one.');
});

test('update and delete take a relationship path to one record', async () => {
    const message = (keyword: string, hint = '') => `"${keyword}" takes a relationship path to one record, such as item.product${hint}.`;
    expect(await check(`module m { ${CART} action A on Cart { effect { update items { set stock = 0 } } } }`))
        .toContain(message('update', '; for every record of a collection, use "for"'));
    expect(await check(`module m { ${CART} action A on Cart { effect { delete this } } }`)).toContain(message('delete'));
    expect(await check(`module m { ${CART} action A on Cart { input { p: Product } effect { delete p } } }`)).toContain(message('delete'));
    expect(await check(`module m { ${CART} action A on Cart { effect { delete tags } } }`)).toContain(message('delete', '; for every record of a collection, use "for"'));
});

test('a set inside update names a field of the updated record', async () => {
    expect(await check(`module m { ${CART} action A on Cart { effect { update owner { set items = [] } } } }`))
        .toContain("Could not resolve reference to Field named 'items'.");
    expect(await check(`module m { ${CART} action A on Cart { effect { update owner { set stock = "x" } } } }`))
        .toContain('String is not assignable to Int.');
});

test('delete self needs an action on an entity', async () => {
    expect(await check(`module m { ${CART} action A { effect { delete self } } }`))
        .toContain('"delete self" needs an action on an entity.');
});

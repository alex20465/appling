import { expect, test } from 'vitest';
import { buildSources, print } from '@appling/lang';
import { examples, uriOf } from '../../lang/test/workspace.js';
import { applyEdit, type EditOperation } from '../src/index.js';

const SALES = uriOf('sales.appling');
const CRM = uriOf('crm.appling');

function sources(): Record<string, string> {
    return Object.fromEntries(Object.entries(examples()).map(([name, text]) => [uriOf(name), text]));
}

/** Applies the edit to the examples, expects success and returns the changed texts, checking they are canonical. */
async function edit(operation: EditOperation): Promise<Record<string, string>> {
    const result = await applyEdit(sources(), operation);
    if (!result.ok) throw new Error(result.errors.join('\n'));
    const workspace = await buildSources(result.sources);
    for (const doc of workspace.documents) expect(print(doc.parseResult.value)).toBe(doc.textDocument.getText());
    return result.sources;
}

async function rejected(operation: EditOperation): Promise<string[]> {
    const result = await applyEdit(sources(), operation);
    expect(result.ok).toBe(false);
    return result.ok ? [] : result.errors;
}

test('rename a field follows references, expressions, projections, picks and message keys', async () => {
    const sales = (await edit({ op: 'rename', target: 'sales.Order.total', name: 'sum_total' }))[SALES];
    expect(sales).toContain('sum_total: Money = sum(lines.map(l, l.amount))');
    expect(sales).toContain('invariant "total never negative" { sum_total >= 0 }');
    expect(sales).toContain('policy read fields sum_total {');
    expect(sales).toContain('step Payments.Charge(order.sum_total)');
    expect(sales).toContain('GET "/orders" -> OpenOrders as OrderSummary { reference, status, sum_total }');
    expect(sales).toContain('OrderSummary.sum_total = "Total"');
});

test('rename an entity across modules and exports', async () => {
    const result = await edit({ op: 'rename', target: 'crm.Account', name: 'Customer' });
    expect(result[CRM]).toContain('export Customer, Clerk');
    expect(result[CRM]).toContain('entity Customer {');
    expect(result[CRM]).toContain('tenant Company on Customer');
    expect(result[SALES]).toContain('customer: crm.Customer');
});

test('rename a module updates qualified names in references and expressions', async () => {
    const result = await edit({ op: 'rename', target: 'crm', name: 'people' });
    expect(result[SALES]).toContain('customer: people.Account');
    expect(result[SALES]).toContain('actor.is(people.Clerk)');
});

test('rename an enum value updates transitions and bare values', async () => {
    const sales = (await edit({ op: 'rename', target: 'sales.OrderStatus.draft', name: 'open' }))[SALES];
    expect(sales).toContain('status: OrderStatus state default open');
    expect(sales).toContain('transition open, placed -> cancelled via Cancel');
    expect(sales).toContain('status == open &&');
});

test('edits span only the changed text', async () => {
    const result = await applyEdit(sources(), { op: 'rename', target: 'sales.Cancel', name: 'Abort' });
    if (!result.ok) throw new Error(result.errors.join('\n'));
    const [edit] = result.edits;
    expect(result.edits.length).toBe(1);
    expect(edit.text.startsWith('Abort') && edit.text.endsWith('Abort')).toBe(true);
    expect(sources()[SALES].slice(edit.offset, edit.offset + edit.length)).toMatch(/^Cancel[\s\S]*Cancel$/);
});

test('add a field to an entity', async () => {
    const sales = (await edit({ op: 'add', parent: 'sales.Order', source: 'note:Text?' }))[SALES];
    expect(sales).toContain('    policy read fields total { status != draft || actor.is(crm.Clerk) }\n    note: Text?\n  }');
});

test('add a precondition finds its place in the action', async () => {
    const sales = (await edit({ op: 'add', parent: 'sales.PlaceOrder', source: 'requires { reference != "" } else EmptyOrder' }))[SALES];
    expect(sales).toContain('requires { lines.size() > 0 } else EmptyOrder\n    requires { reference != "" } else EmptyOrder\n    effect {');
});

test('add an enum value', async () => {
    expect((await edit({ op: 'add', parent: 'sales.OrderStatus', source: 'refunded' }))[SALES]).toContain('    cancelled\n    refunded\n  }');
});

test('add rejects what does not fit', async () => {
    expect(await rejected({ op: 'add', parent: 'sales.OrderStatus', source: 'x: Int' })).toEqual(['"x: Int" does not fit into sales.OrderStatus.']);
});

test('remove an unused field', async () => {
    expect((await edit({ op: 'remove', target: 'crm.Account.email' }))[CRM]).not.toContain('email');
});

test('remove rejects a referenced element', async () => {
    expect((await rejected({ op: 'remove', target: 'sales.Order.placed_at' })).length).toBeGreaterThan(0);
});

test('remove an exported member drops it from the export list', async () => {
    const result = await applyEdit({ [CRM]: 'module crm {\n  export Account, Clerk\n\n  role Clerk\n\n  entity Account {\n    name: String\n  }\n}\n' }, { op: 'remove', target: 'crm.Clerk' });
    expect(result.ok && result.sources[CRM]).toBe('module crm {\n  export Account\n\n  entity Account {\n    name: String\n  }\n}\n');
});

test('retype a field', async () => {
    expect((await edit({ op: 'retype', target: 'sales.Order.reference', type: 'Text' }))[SALES]).toContain('reference: Text unique');
});

test('retype rejects a type that breaks expressions', async () => {
    expect(await rejected({ op: 'retype', target: 'sales.Order.total', type: 'String' })).toContain('Operator ">=" does not apply to String and Int.');
});

test('set replaces, inserts and removes a property', async () => {
    expect((await edit({ op: 'set', target: 'sales.Order.status', property: 'default', value: 'placed' }))[SALES]).toContain('status: OrderStatus state default placed');
    expect((await edit({ op: 'set', target: 'crm.Account.email', property: 'modifiers', value: 'unique' }))[CRM]).toContain('email: String unique\n');
    expect((await edit({ op: 'set', target: 'sales.Order.status', property: 'default', value: '' }))[SALES]).toContain('status: OrderStatus state\n');
    expect((await edit({ op: 'set', target: 'sales.Cancel', property: 'consistency', value: 'eventual' }))[SALES]).toContain('    consistency eventual\n');
});

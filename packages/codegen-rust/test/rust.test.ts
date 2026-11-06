import { expect, test } from 'vitest';
import type { Model } from '@appling/lang';
import { plan } from '@appling/codegen';
import { buildGraph } from '@appling/model';
import { buildWorkspace, examples } from '../../lang/test/workspace.js';
import rust from '../src/index.js';

test('examples generate a Rust crate for the domain and behavior layers', async () => {
    const { documents, services } = await buildWorkspace(examples());
    const result = plan(buildGraph(documents.map(d => d.parseResult.value as Model), services), rust, 'shop');
    const files = new Map<string, string>();
    for (const { step } of result.steps) if (step.kind === 'template') files.set(step.file, step.write(files.get(step.file)));
    expect(Object.fromEntries(files)).toMatchSnapshot();
    const entries = Object.fromEntries(result.entries.map(e => [e.qn, e]));
    expect(entries['sales.PlaceOrder'].status).toBe('partial');
    expect(entries['sales.OpenOrders'].status).toBe('todo');
    expect(entries['sales.Order.total'].status).toBe('generated');
});

const ACCESS = `module m {
  role Clerk { actor.active && tenant != null }
  role Customer
  enum Level {
    gold
    plain
  }
  actor human Member is User roles Customer {
    account: Account
    level: Level
  }
  actor system Clock
  entity User {
    name: String
    active: Bool default true
  }
  entity Account {
    name: String
    policy read { actor.is(Clerk) || (actor.is(Customer) && actor.account == this) }
  }
  tenant Company on Account
  entity Order {
    account: Account
    note: String?
    policy read, update { actor.is(Clerk) || (actor.is(Customer) && account == actor.account) }
    policy read fields note { actor.is(Clerk) }
    policy delete { actor.level == gold }
  }
  action Close on Order {
    policy { actor.is(Clerk) && account == tenant }
  }
}`;

test('roles, actors, the tenant and policies become the access module and pure checks', async () => {
    const { documents, services } = await buildWorkspace({ 'm.appling': ACCESS });
    const result = plan(buildGraph(documents.map(d => d.parseResult.value as Model), services), rust, 'app');
    const files = new Map<string, string>();
    for (const { step } of result.steps) if (step.kind === 'template') files.set(step.file, step.write(files.get(step.file)));
    expect(files.get('src/lib.rs')).toContain('pub mod access;');
    const access = files.get('src/access.rs')!;
    expect(access).toContain('pub fn is_clerk(actor: &Actor) -> bool {\n    actor.has(Role::Clerk) && (actor.active.clone().unwrap_or_default() && actor.tenant.is_some())\n}');
    expect(access).toContain('pub account: Option<i64>,');
    expect(access).not.toContain('pub level');
    const module = files.get('src/m.rs')!;
    expect(module).toContain('crate::access::is_clerk(actor) || (crate::access::is_customer(actor) && (actor.account == Some(account.id)))');
    expect(module).toContain('crate::access::in_tenant(actor, order) && order_policy_read_update(actor, order)');
    expect(module).toContain('pub fn can_read_order_note(actor: &crate::access::Actor, order: &Order) -> bool {\n    can_read_order(actor, order) && order_policy_read_fields_note(actor, order)');
    expect(module).toContain('pub fn can_create_order(_actor: &crate::access::Actor, _order: &Order) -> bool {\n    false');
    expect(module).toContain('crate::access::is_clerk(actor) && (actor.tenant == Some(order.account.id))');
    expect(module).toContain('if !can_close(actor, order) {\n        return Err(Error::Forbidden { action: "Close" });');
    expect(module).toContain('impl crate::access::Tenanted for Order {');
    const entries = Object.fromEntries(result.entries.map(e => [e.qn, e]));
    for (const qn of ['m.Clerk', 'm.Customer', 'm.Clock', 'm.Company', 'm.Member.account']) expect(entries[qn].status).toBe('generated');
    expect(entries['m.Member.level'].status).toBe('todo');
    expect(entries['m.Order.policy[delete]'].missing.map(m => m.what)).toContain('implement the policy m.Order.policy[delete] in order_policy_delete: actor.level == gold');
});

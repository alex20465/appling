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
    expect(entries['sales.OpenOrders'].status).toBe('partial');
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

const DENY = `module n {
  role Clerk
  actor human Staff roles Clerk
  entity Item {
    name: String
    note: String?
    label: String default "new"
    wait: Duration?
    policy read, update { actor.is(Clerk) }
  }
  entity Log {
    text: String
    tags: String[]
  }
  event Noted {
    item: Item
    note: String?
    count: Int
  }
  action Annotate on Item {
    input {
      remark: String?
    }
    effect {
      set note = remark
      emit Noted { item = this, count = 1 }
    }
  }
  action Touch on Log {
    effect {
      set text = "touched"
    }
  }
  action Ping {
    effect {
      emit Noted
    }
  }
  action Record {
    input {
      text: String
    }
    effect {
      create Log { text = text, tags = [] }
    }
  }
}`;

test('once the model has a policy, what no policy covers is denied, and effects assign what their fields hold', async () => {
    const { documents, services } = await buildWorkspace({ 'n.appling': DENY });
    const result = plan(buildGraph(documents.map(d => d.parseResult.value as Model), services), rust, 'app');
    const files = new Map<string, string>();
    for (const { step } of result.steps) if (step.kind === 'template') files.set(step.file, step.write(files.get(step.file)));
    const module = files.get('src/n.rs')!;
    expect(module).toContain('pub fn can_update_log(_actor: &crate::access::Actor, _log: &Log) -> bool {\n    false');
    expect(module).toContain('pub fn can_touch(actor: &crate::access::Actor, log: &Log) -> bool {\n    can_update_log(actor, log)');
    expect(module).toContain('pub fn can_ping(_actor: &crate::access::Actor) -> bool {\n    false');
    expect(module).toContain('if !can_ping(actor) {');
    expect(module).toContain('    item.note = remark.clone();\n');
    expect(module).toContain('    log.text = "touched".to_string();\n');
    expect(module).toContain('            label: "new".to_string(),\n');
    expect(module).toContain('events.push(Event::Noted(Noted { item: Box::new((*item).clone()), note: None, count: 1 }));');
    expect(module).toContain('pub fn record(actor: &crate::access::Actor, text: String, create_log: &mut dyn FnMut(Log) -> Result<(), Error>) -> Result<Vec<Event>, Error> {');
    expect(module).toContain('        let mut created = Log::new(text.clone());\n        created.tags = Vec::new();\n        if !can_create_log(actor, &created) {');
    expect(module).toContain('        create_log(created)?;\n');
    expect(module).toContain('    #[serde(default, with = "crate::serde_duration::option")]\n    pub wait: Option<chrono::TimeDelta>,');
    const lib = files.get('src/lib.rs')!;
    expect(lib).toContain('pub mod serde_duration {');
    expect(lib).toContain('pub mod n;');
    expect(lib.match(/pub mod serde_duration/g)).toHaveLength(1);
    const entries = Object.fromEntries(result.entries.map(e => [e.qn, e]));
    expect(entries['n.Ping'].missing.map(m => m.what)).toContain('emit Noted with its fields item, count, which the model does not give or Rust cannot say');
    expect(entries['n.Record'].missing.map(m => m.what)).toEqual(['write the test n_record']);
});

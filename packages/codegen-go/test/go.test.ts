import { expect, test } from 'vitest';
import type { Model } from '@appling/lang';
import { plan } from '@appling/codegen';
import { buildGraph } from '@appling/model';
import { buildWorkspace, examples } from '../../lang/test/workspace.js';
import go from '../src/index.js';

test('examples generate Go packages for the domain and behavior layers', async () => {
    const { documents, services } = await buildWorkspace(examples());
    const result = plan(buildGraph(documents.map(d => d.parseResult.value as Model), services), go, 'shop');
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

test('roles, actors, the tenant and policies become the access package and pure checks', async () => {
    const { documents, services } = await buildWorkspace({ 'm.appling': ACCESS });
    const result = plan(buildGraph(documents.map(d => d.parseResult.value as Model), services), go, 'app');
    const files = new Map<string, string>();
    for (const { step } of result.steps) if (step.kind === 'template') files.set(step.file, step.write(files.get(step.file)));
    const access = files.get('internal/access/access.go')!;
    expect(access).toContain('func IsClerk(actor Actor) bool {\n\treturn actor.Has(RoleClerk) && (Value(actor.Active) && (actor.Tenant != nil))\n}');
    expect(access).toContain('Account *int64 `json:"account"`');
    expect(access).not.toContain('Level ');
    expect(access).toContain('return Actor{Type: ActorMember, Roles: []Role{RoleCustomer}}');
    const policies = files.get('internal/m/policies.go')!;
    expect(policies).toContain('return access.IsClerk(actor) || (access.IsCustomer(actor) && access.Same(actor.Account, account.ID))');
    expect(policies).toContain('return access.InTenant(actor, order) && orderPolicyReadUpdate(actor, order)');
    expect(policies).toContain('func CanReadOrderNote(actor access.Actor, order *Order) bool {\n\treturn CanReadOrder(actor, order) && orderPolicyReadFieldsNote(actor, order)');
    expect(policies).toContain('func CanCreateOrder(actor access.Actor, order *Order) bool {\n\treturn false');
    expect(policies).toContain('return access.IsClerk(actor) && access.Same(actor.Tenant, order.Account.ID)');
    expect(files.get('internal/m/actions.go')).toContain('if !CanClose(actor, order) {\n\t\treturn nil, fmt.Errorf("%w: Close", access.ErrForbidden)');
    expect(files.get('internal/m/types.go')).toContain('func (o *Order) TenantID() (int64, bool) {\n\tif o.Account == nil {');
    const entries = Object.fromEntries(result.entries.map(e => [e.qn, e]));
    for (const qn of ['m.Clerk', 'm.Customer', 'm.Clock', 'm.Company', 'm.Member.account']) expect(entries[qn].status).toBe('generated');
    expect(entries['m.Member.level'].status).toBe('todo');
    expect(entries['m.Order.policy[delete]'].missing.map(m => m.what)).toContain('implement the policy m.Order.policy[delete] in orderPolicyDelete: actor.level == gold');
});

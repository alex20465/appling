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
    expect(entries['sales.OpenOrders'].status).toBe('partial');
    expect(entries['sales.Order.total'].status).toBe('generated');
});

const INVARIANTS = `module v {
  enum State {
    open
    closed
  }
  entity Ticket {
    title: String
    state: State default open
    points: Int default 0
    note: Text?
    invariant "points in range" { points >= 0 && points <= 100 }
    invariant "noted when closed" { state != closed || note != null }
    invariant "title given" { title != "" }
  }
}`;

test('invariant tests check a valid record and a violation the simulator proves', async () => {
    const { documents, services } = await buildWorkspace({ 'v.appling': INVARIANTS });
    const result = plan(buildGraph(documents.map(d => d.parseResult.value as Model), services), go, 'app');
    const files = new Map<string, string>();
    for (const { step } of result.steps) if (step.kind === 'template') files.set(step.file, step.write(files.get(step.file)));
    const tests = files.get('internal/v/v_test.go')!;
    expect(tests.match(/func validTicket\(\)/g)).toHaveLength(1);
    expect(tests).toContain('\tx := NewTicket()\n\tx.Title = "title-1"\n\treturn x');
    expect(tests).toContain('\t\tx.Points = -1\n');
    expect(tests).toContain('\t\tx.State = StateClosed\n');
    expect(tests).toContain('\t\tx.Title = ""\n');
    expect(tests).toContain('!strings.Contains(err.Error(), "noted when closed")');
    expect(tests).not.toContain('t.Skip');
    const entries = Object.fromEntries(result.entries.map(e => [e.qn, e]));
    expect(entries['v.Ticket.invariant["points in range"]'].status).toBe('generated');
});

test('a default the valid record leaves to New<Entity> adds no import to the test file', async () => {
    const source = `module d {
  entity Slot {
    placed: DateTime default now
    size: Int default 1
    invariant "positive" { size > 0 }
  }
}`;
    const { documents, services } = await buildWorkspace({ 'd.appling': source });
    const result = plan(buildGraph(documents.map(d => d.parseResult.value as Model), services), go, 'app');
    const files = new Map<string, string>();
    for (const { step } of result.steps) if (step.kind === 'template') files.set(step.file, step.write(files.get(step.file)));
    const tests = files.get('internal/d/d_test.go')!;
    expect(tests).toContain('x.Size = -1');
    expect(tests).not.toContain('"time"');
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
    const result = plan(buildGraph(documents.map(d => d.parseResult.value as Model), services), go, 'app');
    const files = new Map<string, string>();
    for (const { step } of result.steps) if (step.kind === 'template') files.set(step.file, step.write(files.get(step.file)));
    const policies = files.get('internal/n/policies.go')!;
    expect(policies).toContain('func CanUpdateLog(actor access.Actor, log *Log) bool {\n\treturn false');
    expect(policies).toContain('func CanTouch(actor access.Actor, log *Log) bool {\n\treturn CanUpdateLog(actor, log)');
    expect(policies).toContain('func CanPing(actor access.Actor) bool {\n\treturn false');
    const actions = files.get('internal/n/actions.go')!;
    expect(actions).toContain('if !CanPing(actor) {');
    expect(actions).toContain('\titem.Note = remark\n');
    expect(actions).toContain('events = append(events, Noted{Item: item, Count: 1})');
    expect(actions).toContain('func Record(actor access.Actor, text string, createLog func(*Log) error) ([]any, error) {');
    expect(actions).toContain('\t\tcreated := NewLog()\n\t\tcreated.Text = text\n\t\tcreated.Tags = []string{}\n\t\tif !CanCreateLog(actor, created) {');
    expect(actions).toContain('\t\tif err := createLog(created); err != nil {');
    expect(actions).not.toContain('Noted{}');
    const entries = Object.fromEntries(result.entries.map(e => [e.qn, e]));
    expect(entries['n.Ping'].missing.map(m => m.what)).toContain('emit Noted with its fields item, count, which the model does not give or Go cannot say');
    expect(entries['n.Record'].missing.map(m => m.what)).toEqual(['write the test TestNRecord']);
});

const CHECKOUT = `module shop {
  entity Product { stock: Int }
  entity Order { total: Int default 0 }
  entity Item { product: Product  quantity: Int }
  entity Line { order: Order?  product: Product  quantity: Int }
  entity Cart {
    items: Item[]
    order: Order?
  }
  action Checkout on Cart {
    effect {
      for item in items {
        create Line as line { order = order, product = item.product, quantity = item.quantity }
        update line.product {
          set stock = stock - line.quantity
        }
        delete item
      }
      update order { set total = total + 1 }
      delete self
    }
  }
}`;

test('loops, updates and deletes of related records and created rows by name hand the records to store functions', async () => {
    const { documents, services } = await buildWorkspace({ 'shop.appling': CHECKOUT });
    const result = plan(buildGraph(documents.map(d => d.parseResult.value as Model), services), go, 'shop');
    const files = new Map<string, string>();
    for (const { step } of result.steps) if (step.kind === 'template') files.set(step.file, step.write(files.get(step.file)));
    expect(files.get('internal/shop/actions.go')).toContain([
        'func Checkout(cart *Cart, createLine func(*Line) error, updateProduct func(*Product) error, updateOrder func(*Order) error, deleteItem func(*Item) error, deleteCart func(*Cart) error) ([]any, error) {',
        '\tvar events []any',
        '\tfor _, item := range cart.Items {',
        '\t\tline := NewLine()',
        '\t\tline.Order = cart.Order',
        '\t\tline.Product = item.Product',
        '\t\tline.Quantity = item.Quantity',
        '\t\tif err := createLine(line); err != nil {',
        '\t\t\treturn nil, err',
        '\t\t}',
        '\t\tline.Product.Stock = line.Product.Stock - line.Quantity',
        '\t\tif err := updateProduct(line.Product); err != nil {',
        '\t\t\treturn nil, err',
        '\t\t}',
        '\t\tif err := deleteItem(item); err != nil {',
        '\t\t\treturn nil, err',
        '\t\t}',
        '\t}',
        '\tif cart.Order != nil {',
        '\t\tcart.Order.Total = (*cart.Order).Total + 1',
        '\t\tif err := updateOrder(cart.Order); err != nil {',
        '\t\t\treturn nil, err',
        '\t\t}',
        '\t}',
        '\tif err := deleteCart(cart); err != nil {'
    ].join('\n'));
    expect(result.entries.find(e => e.qn === 'shop.Checkout')?.missing.map(m => m.what)).toEqual(['write the test TestShopCheckout']);
});

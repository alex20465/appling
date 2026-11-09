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
    expect(entries['sales.PlaceOrder'].status).toBe('generated');
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
    expect(files.get('internal/m/actions.go')).toContain('if !actor.IsSystem() && !CanClose(actor, order) {\n\t\treturn nil, fmt.Errorf("%w: Close", access.ErrForbidden)');
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
    expect(actions).toContain('if !actor.IsSystem() && !CanPing(actor) {');
    expect(actions).toContain('\titem.Note = remark\n');
    expect(actions).toContain('events = append(events, Noted{Item: item, Count: 1})');
    expect(actions).toContain('func Record(actor access.Actor, text string, createLog func(*Log) error) ([]any, error) {');
    expect(actions).toContain('\t\tcreated := NewLog()\n\t\tcreated.Text = text\n\t\tcreated.Tags = []string{}\n\t\tif !actor.IsSystem() && !CanCreateLog(actor, created) {');
    expect(actions).toContain('\t\tif err := createLog(created); err != nil {');
    expect(actions).not.toContain('Noted{}');
    const entries = Object.fromEntries(result.entries.map(e => [e.qn, e]));
    expect(entries['n.Ping'].missing.map(m => m.what)).toContain('emit Noted with its fields item, count, which the model does not give or Go cannot say');
    expect(entries['n.Record'].missing.map(m => m.what)).toEqual(['write the test TestNRecord']);
});

const SCENARIOS = `module s {
  role Clerk
  actor human Agent roles Clerk {
    level: Int
  }
  enum State {
    open
    closed
  }
  entity Ticket {
    title: String
    state: State default open
    points: Int?
    tags: String[]
    policy { actor.is(Clerk) }
  }
  event Closed {
    ticket: Ticket
    points: Int
  }
  action Close on Ticket {
    input {
      score: Int
    }
    requires { score >= 0 } else Negative
    effect {
      set points = score
      emit Closed { ticket = this, points = score }
    }
    errors Negative
  }
  machine Flow on Ticket.state {
    transition open -> closed via Close
  }
  usecase Triage (ticket: Ticket) {
    step Close(ticket, 1)
  }
  scenario Closes {
    given {
      t = create Ticket { title = "a", tags = ["x"] }
      create Ticket { title = "b" }
    }
    as Agent { level = 2 }
    when Close(t, 3)
    then {
      t.state == closed
      t.points == 3
      emitted Closed { ticket = t, points = 3 }
    }
  }
  scenario RefusesNegative {
    given {
      t = create Ticket { title = "c" }
    }
    when Close(t, -1)
    then fails Negative
  }
  scenario Triages {
    given {
      t = create Ticket { title = "d" }
    }
    when Triage(t)
    then {
      t.state == closed
    }
  }
}`;

test('scenarios become tests of the generated action, which replace the guessed tests of what they cover', async () => {
    const { documents, services } = await buildWorkspace({ 's.appling': SCENARIOS });
    const result = plan(buildGraph(documents.map(d => d.parseResult.value as Model), services), go, 'app');
    const files = new Map<string, string>();
    for (const { step } of result.steps) if (step.kind === 'template') files.set(step.file, step.write(files.get(step.file)));
    const tests = files.get('internal/s/scenarios_test.go')!;
    expect(tests).toMatch(/^package s_test\n/);
    expect(tests.match(/func ptr\[/g)).toHaveLength(1);
    expect(tests).toContain('\ttRow := s.NewTicket()\n\ttRow.ID = 1\n\ttRow.Title = "a"\n\ttRow.Tags = []string{"x"}\n');
    expect(tests).toContain('\trow2 := s.NewTicket()\n\trow2.ID = 2\n\trow2.Title = "b"\n');
    expect(tests).toContain('\tactor := access.NewAgent()\n\tactor.Level = ptr[int64](2)\n\tevents, err := s.Close(actor, tRow, 3)\n');
    expect(tests).toContain('if !(tRow.State == s.StateClosed) {');
    expect(tests).toContain('if !((*tRow.Points) == 3) {');
    expect(tests).toContain('\t\tgot, ok := event.(s.Closed)\n\t\treturn ok && (got.Ticket == tRow) && (got.Points == 3)\n');
    expect(tests).toContain('_, err := s.Close(access.System(), tRow, -1)\n\tif !errors.Is(err, s.ErrNegative) {');
    expect(tests).toContain('func TestScenarioTriages(t *testing.T) {\n\tt.Skip("registry task: s.Triages")');
    const entries = Object.fromEntries(result.entries.map(e => [e.qn, e]));
    expect(entries['s.Closes'].status).toBe('generated');
    expect(entries['s.RefusesNegative'].status).toBe('generated');
    expect(entries['s.Triages'].missing.map(m => m.what)).toEqual(['write the test TestScenarioTriages: Triage is a use case, which the Go extension leaves to you']);
    expect(entries['s.Close'].missing).toEqual([]);
    expect(entries['s.Flow.transition[open->closed]'].status).toBe('generated');
    expect(files.get('internal/s/s_test.go') ?? '').not.toContain('TestFlowTransition');
});

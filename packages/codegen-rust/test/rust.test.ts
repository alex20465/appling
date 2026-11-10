import { expect, test } from 'vitest';
import type { Model } from '@appling/lang';
import { plan } from '@appling/codegen';
import { buildGraph } from '@appling/model';
import { buildWorkspace, constructs, examples } from '../../lang/test/workspace.js';
import rust from '../src/index.js';

test('examples generate a Rust crate for the domain and behavior layers', async () => {
    const { documents, services } = await buildWorkspace(examples());
    const result = plan(buildGraph(documents.map(d => d.parseResult.value as Model), services), rust, 'shop');
    const files = new Map<string, string>();
    for (const { step } of result.steps) if (step.kind === 'template') files.set(step.file, step.write(files.get(step.file)));
    expect(Object.fromEntries(files)).toMatchSnapshot();
    const entries = Object.fromEntries(result.entries.map(e => [e.qn, e]));
    // The scenarios that call PlaceOrder replace its guessed test.
    expect(entries['sales.PlaceOrder'].status).toBe('generated');
    expect(entries['sales.EmptyOrderIsRefused'].status).toBe('generated');
    expect(entries['sales.OpenOrders'].status).toBe('partial');
    expect(entries['sales.Order.total'].status).toBe('generated');
});

const INVARIANTS = `module v {
  enum State {
    open
    closed
  }
  value Place {
    city: String
    floor: Int
  }
  entity Owner {
    name: String
  }
  entity Ticket {
    title: String
    owner: Owner
    place: Place
    state: State default open
    points: Int default 0
    note: Text?
    opened: DateTime default now
    invariant "points in range" { points >= 0 && points <= 100 }
    invariant "noted when closed" { state != closed || note != null }
    invariant "title given" { title != "" }
  }
}`;

test('invariant tests check a valid record and a violation the simulator proves', async () => {
    const { documents, services } = await buildWorkspace({ 'v.appling': INVARIANTS });
    const result = plan(buildGraph(documents.map(d => d.parseResult.value as Model), services), rust, 'app');
    const files = new Map<string, string>();
    for (const { step } of result.steps) if (step.kind === 'template') files.set(step.file, step.write(files.get(step.file)));
    const tests = files.get('src/v.rs')!.split('#[cfg(test)]')[1];
    expect(tests.match(/use super::\*;/g)).toHaveLength(1);
    expect(tests.match(/fn valid_ticket\(\)/g)).toHaveLength(1);
    expect(tests).toContain('Ticket::new("title-1".to_string(), Box::new(Owner::new("name-1".to_string())), Place { city: "city-1".to_string(), floor: 1 })');
    expect(tests).toContain('        x.points = -1;\n');
    expect(tests).toContain('        x.state = State::Closed;\n');
    expect(tests).toContain('        x.title = String::new();\n');
    expect(tests).toContain('assert!(errors.contains(&"noted when closed"), "x.state = State::Closed; breaks noted when closed: {errors:?}");');
    expect(tests).not.toContain('#[ignore');
    const entries = Object.fromEntries(result.entries.map(e => [e.qn, e]));
    expect(entries['v.Ticket.invariant["points in range"]'].status).toBe('generated');
});

const TRANSITIONS = `module t {
  enum Phase {
    draft
    review
    done
    archived
  }
  entity Doc {
    title: String
    pages: Int default 1
    phase: Phase state default draft
  }
  entity Note {
    text: String
  }
  event Archived {
    doc: Doc
  }
  action Submit on Doc {
    input {
      reviewer: String
      remark: String?
    }
    requires { pages > 0 }
    effect {
      create Note { text = reviewer }
    }
  }
  action Finish on Doc {
    input {
      due: Date
    }
  }
  action Rework on Doc {
    requires { pages > 5 }
  }
  machine DocFlow on Doc.phase {
    transition draft -> review via Submit
    transition review -> done via Finish
    transition review -> draft via Rework
    transition done -> archived on Archived
  }
}`;

test('transition tests run the action from a proven state and expect the invalid transition error elsewhere', async () => {
    const { documents, services } = await buildWorkspace({ 't.appling': TRANSITIONS });
    const result = plan(buildGraph(documents.map(d => d.parseResult.value as Model), services), rust, 'app');
    const files = new Map<string, string>();
    for (const { step } of result.steps) if (step.kind === 'template') files.set(step.file, step.write(files.get(step.file)));
    const tests = files.get('src/t.rs')!.split('#[cfg(test)]')[1];
    expect(tests.match(/fn valid_doc\(\)/g)).toHaveLength(1);
    expect(tests).toContain([
        '    fn doc_flow_transition_draft_review() {',
        '        let mut x = valid_doc();',
        '        x.phase = Phase::Draft;',
        '        submit(&mut x, "reviewer-1".to_string(), None, &mut |_: Note| Ok(())).expect("submit from draft");',
        '        assert_eq!(x.phase, Phase::Review, "submit from draft goes to review");',
        '        let mut x = valid_doc();',
        '        x.phase = Phase::Review;',
        '        assert!(matches!(submit(&mut x, "reviewer-1".to_string(), None, &mut |_: Note| Ok(())), Err(Error::InvalidTransition { .. })), "submit refuses review");',
        '    }'
    ].join('\n'));
    // A date input has no value the simulator knows, the precondition of Rework fails on the valid record, and Archived is an event.
    for (const name of ['review_done', 'review_draft', 'done_archived']) expect(tests).toContain(`#[ignore = "registry task: t.DocFlow.transition[${name.replace('_', '->')}]"]`);
    const entries = Object.fromEntries(result.entries.map(e => [e.qn, e]));
    expect(entries['t.DocFlow.transition[draft->review]'].status).toBe('generated');
    expect(entries['t.DocFlow.transition[review->done]'].missing.map(m => m.what)).toEqual(['write the test doc_flow_transition_review_done']);
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
        update item.product {
          set stock = stock - item.quantity
        }
        create Line as line { order = order, product = item.product, quantity = item.quantity }
        delete item
      }
      update order { set total = total + 1 }
      delete self
    }
  }
}`;

const SCENARIOS = `module s {
  export Customer, Item, Basket, Place, Placed, Phase
  enum Phase {
    draft
    placed
  }
  entity Customer {
    name: String
  }
  entity Item {
    sku: String
    price: Money
  }
  entity Basket {
    owner: Customer
    items: Item[]
    phase: Phase state default draft
    note: String?
    count: Int default 0
    total: Money = sum(items.map(i, i.price))
  }
  event Placed {
    basket: Basket
    note: String?
    count: Int
  }
  action Place on Basket {
    input {
      remark: String
      extra: Int?
    }
    requires { items.size() > 0 } else Empty
    effect {
      set note = remark
      set count = items.size()
      emit Placed { basket = this, note = remark, count = items.size() }
    }
    errors Empty
  }
  machine Flow on Basket.phase {
    transition draft -> placed via Place
  }
  scenario PlaceBasket does "A basket with an item is placed" {
    given {
      ada = create Customer { name = "Ada" }
      ink = create Item { sku = "ink", price = 2.5 }
      basket = create Basket { owner = ada, items = [ink] }
      create Item { sku = "pen", price = 1 }
    }
    when Place(basket, "now")
    then {
      basket.phase == placed
      basket.total == 2.5
      basket.note == "now"
      basket.owner.name == "Ada"
      emitted Placed { basket = basket, note = "now", count = 1 }
      emitted Placed
    }
  }
  scenario EmptyBasket {
    given {
      ada = create Customer { name = "Ada" }
      basket = create Basket { owner = ada }
    }
    when Place(basket, "x")
    then fails Empty
  }
  scenario PlacedTwice {
    given {
      ada = create Customer { name = "Ada" }
      ink = create Item { sku = "ink", price = 2 }
      basket = create Basket { owner = ada, items = [ink], phase = placed }
    }
    when Place(basket, "x")
    then fails
  }
  scenario SameOwner {
    given {
      ada = create Customer { name = "Ada" }
      ink = create Item { sku = "ink", price = 2 }
      basket = create Basket { owner = ada, items = [ink] }
    }
    when Place(basket, "x")
    then {
      basket.owner == ada
    }
  }
}

module t {
  scenario FromOutside {
    given {
      ada = create s.Customer { name = "Ada" }
      ink = create s.Item { sku = "ink", price = 2 }
      basket = create s.Basket { owner = ada, items = [ink] }
    }
    when s.Place(basket, "x", 3)
    then {
      basket.count == 1
      emitted s.Placed { basket = basket }
    }
  }
}`;

test('loops, updates and deletes of related records and created rows by name hand the records to store functions', async () => {
    const { documents, services } = await buildWorkspace({ 'shop.appling': CHECKOUT });
    const result = plan(buildGraph(documents.map(d => d.parseResult.value as Model), services), rust, 'shop');
    const files = new Map<string, string>();
    for (const { step } of result.steps) if (step.kind === 'template') files.set(step.file, step.write(files.get(step.file)));
    expect(files.get('src/shop.rs')).toContain([
        'pub fn checkout(cart: &mut Cart, create_line: &mut dyn FnMut(Line) -> Result<(), Error>, update_product: &mut dyn FnMut(&Product) -> Result<(), Error>, update_order: &mut dyn FnMut(&Order) -> Result<(), Error>, delete_item: &mut dyn FnMut(&Item) -> Result<(), Error>, delete_cart: &mut dyn FnMut(&Cart) -> Result<(), Error>) -> Result<Vec<Event>, Error> {',
        '    let events = Vec::new();',
        '    for item in cart.items.iter_mut() {',
        '        item.product.stock = item.product.stock - item.quantity;',
        '        update_product(&*item.product)?;',
        '        let mut line = Line::new(Box::new((*item.product).clone()), item.quantity.clone());',
        '        line.order = cart.order.clone();',
        '        create_line(line.clone())?;',
        '        delete_item(&*item)?;',
        '    }',
        '    if let Some(record) = cart.order.as_deref_mut() {',
        '        record.total = record.total + 1;',
        '        update_order(&*record)?;',
        '    }',
        '    delete_cart(&*cart)?;'
    ].join('\n'));
    expect(result.entries.find(e => e.qn === 'shop.Checkout')?.missing.map(m => m.what)).toEqual(['write the test shop_checkout']);
});

test('scenarios become tests with the given rows, the call and the then, and replace the guessed tests of what they call', async () => {
    const { documents, services } = await buildWorkspace({ 's.appling': SCENARIOS });
    const result = plan(buildGraph(documents.map(d => d.parseResult.value as Model), services), rust, 'app');
    const files = new Map<string, string>();
    for (const { step } of result.steps) if (step.kind === 'template') files.set(step.file, step.write(files.get(step.file)));
    const tests = files.get('src/s.rs')!.split('#[cfg(test)]')[1];
    expect(tests).toContain([
        '    fn scenario_place_basket() {',
        '        let mut ada = Customer::new("Ada".to_string());',
        '        ada.id = 1;',
        '        let mut ink = Item::new("ink".to_string(), rust_decimal::Decimal::from_str_exact("2.5").unwrap());',
        '        ink.id = 2;',
        '        let mut basket = Basket::new(Box::new(ada.clone()));',
        '        basket.id = 3;',
        '        basket.items = vec![ink.clone()];',
        '        let mut _given_4 = Item::new("pen".to_string(), rust_decimal::Decimal::from(1));',
        '        _given_4.id = 4;',
        '        let outcome = place(&mut basket, "now".to_string(), None);',
        '        let events = outcome.expect("place runs");',
        '        assert!(basket.phase == Phase::Placed, "basket.phase == placed");',
        '        assert!(basket.total() == rust_decimal::Decimal::from_str_exact("2.5").unwrap(), "basket.total == 2.5");',
        '        assert!(basket.note.clone().unwrap() == "now", "basket.note == \\"now\\"");'
    ].join('\n'));
    expect(tests).toContain('assert!(events.iter().any(|emitted| matches!(emitted, Event::Placed(fired) if fired.basket.id == basket.id && fired.note == Some("now".to_string()) && fired.count == 1)), "place emits Placed {{ basket = basket, note = \\"now\\", count = 1 }}: {events:?}");');
    expect(tests).toContain('assert!(matches!(outcome, Err(Error::Empty)), "place fails with Empty: {outcome:?}");');
    expect(tests).toContain('assert!(matches!(outcome, Err(ref error) if !matches!(error, Error::Forbidden { .. })), "place fails: {outcome:?}");');
    // A scenario calling another module's action names everything by its crate path, without `use super::*;`.
    const outside = files.get('src/t.rs')!.split('#[cfg(test)]')[1];
    expect(outside).not.toContain('use super::*;');
    expect(outside).toContain('let outcome = crate::s::place(&mut basket, "x".to_string(), Some(3));');
    expect(outside).toContain('matches!(emitted, crate::s::Event::Placed(fired) if fired.basket.id == basket.id)');
    const entries = Object.fromEntries(result.entries.map(e => [e.qn, e]));
    for (const qn of ['s.EmptyBasket', 's.PlacedTwice', 't.FromOutside']) expect(entries[qn].status).toBe('generated');
    expect(entries['s.SameOwner'].missing.map(m => m.what)).toEqual(['write the test scenario_same_owner: a check compares records, which Rust holds as clones']);
    // The scenarios replace the guessed tests of the action they call and of its transition.
    expect(tests).not.toContain('fn s_place()');
    expect(entries['s.Place'].missing).toEqual([]);
    expect(entries['s.Flow.transition[draft->placed]'].status).toBe('generated');
});

test('a scenario Rust cannot run as the simulator does stays an ignored test with the reason as its task', async () => {
    const { documents, services } = await buildWorkspace(constructs());
    const result = plan(buildGraph(documents.map(d => d.parseResult.value as Model), services), rust, 'shop');
    const entries = Object.fromEntries(result.entries.map(e => [e.qn, e]));
    expect(entries['shop.PlaceFullOrder'].missing.map(m => m.what)).toContain('write the test scenario_place_full_order: place_order always checks an actor, and the simulator passes the scenario as no declared actor');
    expect(entries['shop.EmptyCheckout'].missing.map(m => m.what)).toEqual(['write the test scenario_empty_checkout: the use case Checkout has no generated function to call']);
    expect(entries['shop.ShopperCannotCancel'].status).toBe('generated');
});

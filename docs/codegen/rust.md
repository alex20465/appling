---
title: Rust
description: Generate a Rust library crate for the domain and behavior layers of a model, ready to put behind your own storage and HTTP code.
---

The `@appling/codegen-rust` extension writes a library crate with one Rust module per Appling module. Like the [Go extension](go.md), it covers types, invariants, derived fields, actions with their state transitions, errors and events, and access (actors, roles, the tenant and the policies as pure checks), and leaves storage, HTTP and scheduling to you as [registry](registry.md) tasks.

## Requirements

Rust 1.85 or later with Cargo. Setup adds `serde`, `rust_decimal` and `chrono` with `cargo add`.

## Configuration

```json
{
  "generate": [
    { "extension": "@appling/codegen-rust", "out": "build/shop" }
  ]
}
```

The crate name is the project name in snake case. The module `sales` is `src/sales.rs`, declared in `src/lib.rs`; nested modules `a.b` become `src/a/b.rs`, declared in `src/a.rs`.

## Model to Rust

| Model | Rust |
|---|---|
| `enum` | an enum deriving `Copy`, `PartialEq` and serde, with the Appling value names as serde names |
| `value`, `event` | a struct deriving `Clone`, `PartialEq` and serde; every event is also a variant of the module's `Event` enum |
| `entity` | a struct with `id: i64`, `new()` taking the fields that have no default and are neither optional nor lists, one method per derived field, and `validate()` returning the labels of the invariants that fail |
| field types | `String`, `i64`, `bool`, `rust_decimal::Decimal`, `chrono::DateTime<chrono::Utc>`, `chrono::NaiveDate`, `chrono::TimeDelta`; entities as `Box<Entity>`, lists as `Vec<T>`, optional fields as `Option<T>` |
| `Duration` fields | `chrono::TimeDelta` has no serde support, so these fields go through `crate::serde_duration` (written into `src/lib.rs`), which encodes a duration as whole nanoseconds, the way Go encodes a `time.Duration` |
| `action` | a function taking `&mut` the entity and the inputs, returning `Result<Vec<Event>, Error>`: preconditions return the declared error (`Error::Precondition` when none is declared), the transition is a `match` on the state with guards as match guards and `Error::InvalidTransition` otherwise, effects change the record, emitted events are returned. Once the model has a policy, it takes `&Actor` first and returns `Error::Forbidden` unless `can_<action>` holds |
| `create` effect | the action builds the record with `<Entity>::new` and the given fields, checks `can_create_<entity>` once the model has a policy, and hands it to a `create_<entity>: &mut dyn FnMut(Entity) -> Result<(), Error>` parameter, which stores it |
| `emit` effect | an event with the given fields, `None` or an empty `Vec` for the optional ones it leaves out; an event whose required fields the effect does not give is a registry task |
| `create ... as name` | the same, with the record in `let mut name` for the effects after it; the create function gets a clone |
| `for` effect | `for item in order.items.iter() { ... }`, `iter_mut()` when an `update` changes a record the loop variable leads to |
| `update` effect | assigns the fields of the record the path leads to, checks `can_update_<entity>` once the model has a policy, and hands it to an `update_<entity>: &mut dyn FnMut(&Entity) -> Result<(), Error>` parameter; an optional record at the end of the path is changed through `if let Some(record) = ... .as_deref_mut()` |
| `delete` effect | checks `can_delete_<entity>` once the model has a policy and hands the record (`delete self`: the action's own) to a `delete_<entity>: &mut dyn FnMut(&Entity) -> Result<(), Error>` parameter |
| `machine` | transitions on an event become `<machine>_on_<event>(&mut event)` |
| `errors` | variants of the module's `Error` enum, next to `InvalidTransition` and `Forbidden` |
| `role`, `actor`, `tenant` | the module `src/access.rs`, see [Access](#access) |
| `policy` | a function per policy and the `can_...` checks, see [Policies](#policies) |
| invariants | a test in the module's `tests` per invariant that `validate()` checks: `valid_<entity>()` (`<Entity>::new` with a sample for every argument, records through their own `new`, value types field by field) passes `validate()`, and the same record with one field set to a value the simulator proves to break the invariant fails with its label. Without such a value the violation case is a registry task; without a sample for every argument the test stays `#[ignore]`d |
| transitions | a test in the module's `tests` per transition an action runs: `valid_<entity>()` in a `from` state goes to the `to` state through the action, and the action refuses a state no transition of it leaves with `Error::InvalidTransition`. Once the model has a policy, the test passes the first declared actor (`Actor::<actor>()`) the simulator proves the policies let run the action; records the action creates go to create functions that store nothing. The test stays `#[ignore]`d as a registry task when the simulator cannot prove that the preconditions and the guard hold for the record and the sample inputs, when an earlier transition of the action could take the record, when a policy involved has no Rust translation, when no actor is proven allowed, or when the action, the entity and the machine are in different modules; so do transitions on an event |
| policies, preconditions | `#[ignore]`d tests in the module's `tests` |
| `scenario` | a test `scenario_<name>` in the module's `tests` that builds the given rows, calls the action and checks the `then`, see [Scenarios](#scenarios) |

This is the generated `place_order` of the [example](../../examples/sales.appling):

```rust
/// The action sales.PlaceOrder. It returns the events it emits.
pub fn place_order(actor: &crate::access::Actor, order: &mut Order) -> Result<Vec<Event>, Error> {
    let mut events = Vec::new();
    if !can_place_order(actor, order) {
        return Err(Error::Forbidden { action: "PlaceOrder" });
    }
    if !((order.lines.len() as i64) > 0) {
        return Err(Error::EmptyOrder);
    }
    match order.status {
        OrderStatus::Draft => {
            events.push(Event::OrderPlaced(OrderPlaced { order: Box::new((*order).clone()) }));
            order.status = OrderStatus::Placed;
        }
        _ => return Err(Error::InvalidTransition { action: "PlaceOrder", from: format!("{:?}", order.status) }),
    }
    order.placed_at = Some(chrono::Utc::now());
    Ok(events)
}
```

## Access

[Roles, actors and the tenant](../language/access.md) become the module `src/access.rs` (`access_control` when the model has a module named `access`), in the same shape as the [Go extension's](go.md#access) access package: fields holding records hold their id.

| Model | Rust |
|---|---|
| `role` | a variant of `Role` (`Role::Clerk`) and `is_<role>(actor: &Actor) -> bool`: the actor carries the role and the role's condition holds |
| `actor` | a variant of `ActorType` and `Actor::<actor>()`, an `Actor` with the declared roles |
| actor fields, fields of the `is` entity | fields of `Actor`, `Option`s that are `None` for actors without them; records as `Option<i64>` ids |
| `tenant` | `Actor::tenant`, the id of the tenant's entity, the `Tenanted` trait and `in_tenant(actor, record)`; every entity that reaches the tenant's entity through single references implements `Tenanted` |

A role or actor name that is not unique across modules is prefixed with its module path (`Role::CrmClerk`). An actor without a tenant acts across tenants. Actor fields typed with an enum or a value type are not generated yet; each is a registry task.

## Policies

Each policy becomes a private function in its module, such as `order_policy_read(actor, order)`: `actor.is(Clerk)` calls `crate::access::is_clerk(actor)`, `actor.account` reads `actor.account`, and `customer == actor.account` becomes `actor.account == Some(order.customer.id)`. The public checks combine them with `&&`:

| Element | Checks |
|---|---|
| `entity` | `can_<op>_<entity>(actor, record)` for `read`, `create`, `update` and `delete`, false for an operation no policy grants; `can_<op>_<entity>_<field>` for the fields a field policy narrows. A record in the tenant also needs `in_tenant` |
| `action` | `can_<action>(actor, record, inputs...)`: the update check of its entity and the action's own policies, false when there is neither; the action calls it first. An action without an entity that creates records and has no policy of its own checks `can_create_<entity>` on each record instead |
| `query` | `can_<query>(actor, record, inputs...)`: the read check of its entity and the query's own policies |
| `usecase` | `can_<use case>(actor, params...)` from its own policies; the actions it runs check themselves |

Once the model has any policy, an operation that no policy covers is denied, the same rule as the [Django extension](django.md): an entity without policies gets checks that all return `false`, so its actions are forbidden too. A model without policies generates no checks, and its actions take no actor; only a [tenant](../language/access.md) then guards the actions on records in the tenant. Transitions on an event run without an actor and check nothing.

Checks borrow single required records and take every other input by value. A policy whose condition has no Rust translation returns `false` until you write it; the registry lists it as a task. Its tests stay ignored, with their bodies as registry tasks.

## Scenarios

Each [scenario](../language/scenarios.md) becomes one test, `scenario_<name>`, in the `tests` module of the scenario's module. It reproduces the run of the [simulator](../tools/simulator.md), which has to pass the scenario first.

| Scenario | Rust |
|---|---|
| `given` row | `let mut <name> = <Entity>::new(...)` with the given values and a sample for every required field the scenario does not give, then the other given fields; each row gets its own `id` (1, 2, ...) in order, so records compare by id as the simulator compares rows. A record field holds `Box::new(<row>.clone())`, a list of records `vec![<row>.clone(), ...]`. A row without a name is `_given_<n>` |
| `as` | `Actor::<actor>()` (a role stands for the first actor holding it) with the given fields set: records as `Some(<row>.id)`, other values in `Some` |
| no `as` | the call goes without an actor when the action takes none. Once the model has a policy every action checks an actor, so the test uses the first declared actor the simulator also passes the scenario as |
| `when` an action | one call of the action's function: `&mut` the row, the inputs in order (`None` or `Vec::new()` for optional inputs left out), and create functions that store nothing |
| `then` checks | `assert!` per expression over the rows, which the call changed in place; optional fields are read through a clone |
| `emitted E { f = v }` | `assert!` that the returned events hold an `Event::E` with those field values, records by id |
| `then fails E` | `assert!(matches!(outcome, Err(Error::E)))` |
| `then fails` | an error other than `Error::Forbidden` |
| `then refused` | `Error::Forbidden` |

A scenario test replaces the guessed tests of what it covers: the action its `when` runs gets no ignored test of its own, and the transitions that action triggers get no transition test, so their registry entries have no test task.

This is the test of `EmptyOrderIsRefused` in the [example](../../examples/sales.appling), which calls `POST /orders/{id}/place` of `PublicApi`:

```rust
#[test]
fn scenario_empty_order_is_refused() {
    let mut acme = crate::crm::Account::new("Acme".to_string(), "email-1".to_string());
    acme.id = 1;
    let mut order = Order::new("A-2".to_string(), Box::new(acme.clone()), chrono::Utc::now());
    order.id = 2;
    let mut actor = crate::access::Actor::shopper();
    actor.account = Some(acme.id);
    let outcome = place_order(&actor, &mut order);
    assert!(matches!(outcome, Err(Error::EmptyOrder)), "place_order fails with EmptyOrder: {outcome:?}");
}
```

The test stays `#[ignore]`d, with the reason as the Scenario entry's registry task, when Rust cannot run the scenario the way the simulator does: the `when` runs a use case (use cases have no generated function), the simulator does not pass the scenario, the action has registry tasks of its own, a policy or role condition the call checks has no Rust translation, no declared actor fits a call without `as`, a given value, actor field or check has no Rust translation, a check compares two records (Rust holds them as clones), a check reads the called row through another record (that record holds a clone from before the call), or, for `then fails E`, the simulator cannot prove that `E` is the first error the action returns.

## What becomes a task

Queries, projections, interfaces, pages, flows, messages, use cases, external systems and jobs (queries and use cases still get their `can_...` check, and a query whose filter translates gets `in_<query>(record, inputs...) -> bool`, which says whether a record belongs to its results), and derived fields, defaults, preconditions, guards, policies and effects without a Rust translation, such as `actor` outside a policy or a role, string matching with `matches`, a `create`, `update` or `delete` effect that runs in a transition on an event, a `create` effect that leaves a required field without default unset, an `update` or `delete` whose path goes through an optional record before its end, a loop that changes its records while calling a method of the action's record, and an `emit` effect that leaves a required field of its event unset. The extension stays at the domain and behavior layers on purpose: generating the layers above means picking a storage, HTTP and scheduling stack, and that choice is deferred while Django and Ash catch up.

## Run the generated project

```sh
cd build/shop
cargo test
```

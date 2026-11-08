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
| `machine` | transitions on an event become `<machine>_on_<event>(&mut event)` |
| `errors` | variants of the module's `Error` enum, next to `InvalidTransition` and `Forbidden` |
| `role`, `actor`, `tenant` | the module `src/access.rs`, see [Access](#access) |
| `policy` | a function per policy and the `can_...` checks, see [Policies](#policies) |
| invariants | a test in the module's `tests` per invariant that `validate()` checks: `valid_<entity>()` (`<Entity>::new` with a sample for every argument, records through their own `new`, value types field by field) passes `validate()`, and the same record with one field set to a value the simulator proves to break the invariant fails with its label. Without such a value the violation case is a registry task; without a sample for every argument the test stays `#[ignore]`d |
| policies, transitions, preconditions | `#[ignore]`d tests in the module's `tests` |

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
| `query` | `can_<query>(actor, record)`: the read check of its entity and the query's own policies |
| `usecase` | `can_<use case>(actor, params...)` from its own policies; the actions it runs check themselves |

Once the model has any policy, an operation that no policy covers is denied, the same rule as the [Django extension](django.md): an entity without policies gets checks that all return `false`, so its actions are forbidden too. A model without policies generates no checks, and its actions take no actor; only a [tenant](../language/access.md) then guards the actions on records in the tenant. Transitions on an event run without an actor and check nothing.

Checks borrow single required records and take every other input by value. A policy whose condition has no Rust translation returns `false` until you write it; the registry lists it as a task. Its tests stay ignored, with their bodies as registry tasks.

## What becomes a task

Queries, projections, interfaces, pages, flows, messages, use cases, external systems and jobs (queries and use cases still get their `can_...` check), and derived fields, defaults, preconditions, guards, policies and effects without a Rust translation, such as `actor` outside a policy or a role, string matching with `matches`, a `create` effect that leaves a required field without default unset or runs in a transition on an event, and an `emit` effect that leaves a required field of its event unset. The extension stays at the domain and behavior layers on purpose: generating the layers above means picking a storage, HTTP and scheduling stack, and that choice is deferred while Django and Ash catch up.

## Run the generated project

```sh
cd build/shop
cargo test
```

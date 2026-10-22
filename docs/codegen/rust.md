---
title: Rust
description: Generate a Rust library crate for the domain and behavior layers of a model, ready to put behind your own storage and HTTP code.
---

The `@appling/codegen-rust` extension writes a library crate with one Rust module per Appling module. Like the [Go extension](go.md), it covers types, invariants, derived fields, actions with their state transitions, errors and events, and leaves storage, HTTP and scheduling to you as [registry](registry.md) tasks.

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
| `action` | a function taking `&mut` the entity and the inputs, returning `Result<Vec<Event>, Error>`: preconditions return the declared error, the transition is a `match` on the state with guards as match guards and `Error::InvalidTransition` otherwise, effects change the record, emitted events are returned |
| `machine` | transitions on an event become `<machine>_on_<event>(&mut event)` |
| `errors` | variants of the module's `Error` enum |
| invariants, policies, transitions, preconditions | `#[ignore]`d tests in the module's `tests` |

This is the generated `place_order` of the [example](../../examples/sales.appling):

```rust
/// The action sales.PlaceOrder. It returns the events it emits.
pub fn place_order(order: &mut Order) -> Result<Vec<Event>, Error> {
    let mut events = Vec::new();
    if !((order.lines.len() as i64) > 0) {
        return Err(Error::EmptyOrder);
    }
    match order.status {
        OrderStatus::Draft => {
            events.push(Event::OrderPlaced(OrderPlaced { order: Box::new(order.clone()) }));
            order.status = OrderStatus::Placed;
        }
        _ => return Err(Error::InvalidTransition { action: "PlaceOrder", from: format!("{:?}", order.status) }),
    }
    order.placed_at = Some(chrono::Utc::now());
    Ok(events)
}
```

## What becomes a task

Queries, projections, interfaces, pages, flows, messages, use cases, external systems, jobs and policies, and derived fields, defaults, preconditions, guards and effects without a Rust translation, such as expressions over `actor`, string matching with `matches` and effects that create records.

## Run the generated project

```sh
cd build/shop
cargo test
```

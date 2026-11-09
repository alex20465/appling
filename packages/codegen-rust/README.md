# @appling/codegen-rust

Appling code generation extension for Rust. It turns the domain and behavior layers of an Appling model into a library crate with one module per Appling module, using serde, [rust_decimal](https://crates.io/crates/rust_decimal) and [chrono](https://crates.io/crates/chrono), so you can put it behind the storage and HTTP crates you choose.

```json
{
  "generate": [
    { "extension": "@appling/codegen-rust", "out": "build/shop" }
  ]
}
```

Requires Rust 1.85 or later. The crate name is the project name in snake case.

## What it generates

| Model | Rust, in `src/<module>.rs` |
|---|---|
| `enum` | an enum with serde names for the values |
| `value`, `event` | a struct with serde derives; events are also variants of the module's `Event` enum |
| `entity` | a struct with an `id`, `new()` taking the fields without default, a method per derived field, and `validate()` returning the labels of failing invariants |
| optional fields, entity references, lists | `Option<T>`, `Box<Entity>`, `Vec<T>` |
| `action` | a function on `&mut` the entity returning `Result<Vec<Event>, Error>`: preconditions return the declared errors, the transition is a `match` on the state with guards, effects change the record, emitted events are returned; a `create` effect builds the record, checks it and hands it to a `create_<entity>` parameter that stores it; `for` loops over a collection relationship, and `update` and `delete` effects check the record and hand it to `update_<entity>` and `delete_<entity>` parameters |
| `Duration` fields | `chrono::TimeDelta`, serialized as nanoseconds through `crate::serde_duration` in `src/lib.rs`, since chrono has no serde support for it |
| `machine` | for transitions on an event, a function `<machine>_on_<event>(&mut event)` |
| `errors` | variants of the module's `Error` enum, next to `InvalidTransition` and `Forbidden` |
| `role`, `actor`, `tenant` | the module `src/access.rs`: `Actor` (type, roles, tenant, the actor fields, records by id), `is_<role>(actor)` checks, `Actor::<actor>()`, and `in_tenant` with `Tenanted` on every entity that belongs to the tenant |
| `policy` | pure checks: `can_<op>_<entity>`, `can_<op>_<entity>_<field>`, `can_<action>` (called by the action, which then takes `&Actor` and returns `Error::Forbidden`), `can_<query>`, `can_<use case>`. Once the model has any policy, every entity, action and query gets its check, and what no policy covers is denied |
| invariants | a test in the module's `tests`: `valid_<entity>()` passes `validate()`, and one field set to a value the simulator proves to break the invariant fails with its label (without such a value that case stays a registry task) |
| transitions | a test in the module's `tests` per transition an action runs: `valid_<entity>()` in a `from` state reaches the `to` state, a state the action does not leave fails with `Error::InvalidTransition`; with policies it passes an actor the simulator proves allowed. `#[ignore]`d as a registry task when the simulator cannot prove the preconditions, the guard or the actor |
| policies, preconditions | `#[ignore]`d tests in the module's `tests`; writing their bodies is a registry task |

Queries, projections, interfaces, pages, use cases, external systems and jobs become registry tasks, as do policies Rust cannot translate (their check returns `false` until written). `cargo test` is the registry's test command. The extension stays at the domain and behavior layers on purpose: generating the layers above means picking a storage, HTTP and scheduling stack, and that choice is deferred while Django and Ash catch up.

## License

MIT

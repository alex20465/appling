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
| `action` | a function on `&mut` the entity returning `Result<Vec<Event>, Error>`: preconditions return the declared errors, the transition is a `match` on the state with guards, effects change the record, emitted events are returned |
| `machine` | for transitions on an event, a function `<machine>_on_<event>(&mut event)` |
| `errors` | variants of the module's `Error` enum, next to `InvalidTransition` |
| rules | `#[ignore]`d tests in the module's `tests`; writing their bodies is a registry task |

Queries, projections, interfaces, pages, use cases, external systems, jobs and policies become registry tasks. `cargo test` is the registry's test command.

## License

MIT

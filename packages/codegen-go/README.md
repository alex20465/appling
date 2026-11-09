# @appling/codegen-go

Appling code generation extension for Go. It turns the domain and behavior layers of an Appling model into plain Go packages, one per module, with no framework, so you can put them behind the storage and HTTP libraries you choose.

```json
{
  "generate": [
    { "extension": "@appling/codegen-go", "out": "build/shop" }
  ]
}
```

Requires Go 1.22 or later. Money and decimals use [shopspring/decimal](https://github.com/shopspring/decimal).

## What it generates

| Model | Go, in `internal/<module>/` |
|---|---|
| `module` | a package with `doc.go` |
| `enum` | a string type with one constant per value (`OrderStatusDraft`) |
| `value`, `event` | a struct with JSON tags |
| `entity` | a struct with an `ID`, `New<Entity>()` with the defaults, a method per derived field, and `Validate()` that checks the invariants |
| optional fields, entity references, lists | pointers, `*Entity`, slices |
| `action` | a function on the entity that checks the preconditions (returning the declared errors), takes the state transition (`ErrInvalidTransition` otherwise), applies the effects and returns the emitted events; a `create` effect builds the record, checks it and hands it to a `create<Entity>` parameter that stores it; `for` loops over a collection relationship, and `update` and `delete` effects check the record and hand it to `update<Entity>` and `delete<Entity>` parameters |
| `machine` | for transitions on an event, a function `<Machine>On<Event>(event)` |
| `errors` | `Err<Name>` variables |
| `role`, `actor`, `tenant` | the package `internal/access`: `Actor` (type, roles, tenant, the actor fields, records by ID), `Is<Role>(actor)` checks, `New<Actor>()`, and `InTenant` with `TenantID()` on every entity that belongs to the tenant |
| `policy` | pure checks in `policies.go`: `Can<Op><Entity>`, `Can<Op><Entity><Field>`, `Can<Action>` (called by the action, which then takes the actor and returns `access.ErrForbidden`), `Can<Query>`, `Can<UseCase>`. Once the model has any policy, every entity, action and query gets its check, and what no policy covers is denied |
| invariants | a test in `<module>_test.go`: `valid<Entity>()` passes `Validate`, and one field set to a value the simulator proves to break the invariant fails with its label (without such a value that case stays a registry task) |
| transitions | a test in `<module>_test.go` per transition an action runs: `valid<Entity>()` in a `from` state reaches the `to` state, a state the action does not leave fails with `ErrInvalidTransition`; with policies it passes an actor the simulator proves allowed. Skipped as a registry task when the simulator cannot prove the preconditions, the guard or the actor |
| policies, preconditions | skipped tests in `<module>_test.go`; writing their bodies is a registry task |

Queries, projections, interfaces, pages, use cases, external systems and jobs become registry tasks, as do policies Go cannot translate (their check returns false until written): they need storage, HTTP and scheduling choices the model does not make. The project ends with `gofmt -w .`, and `go test ./...` is the registry's test command. The extension stays at the domain and behavior layers on purpose: generating the layers above means picking a storage, HTTP and scheduling stack, and that choice is deferred while Django and Ash catch up.

## License

MIT

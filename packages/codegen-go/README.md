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
| `action` | a function on the entity that checks the preconditions (returning the declared errors), takes the state transition (`ErrInvalidTransition` otherwise), applies the effects and returns the emitted events |
| `machine` | for transitions on an event, a function `<Machine>On<Event>(event)` |
| `errors` | `Err<Name>` variables |
| rules | skipped tests in `<module>_test.go`; writing their bodies is a registry task |

Queries, projections, interfaces, pages, use cases, external systems, jobs and policies become registry tasks: they need storage, HTTP and scheduling choices the model does not make. The project ends with `gofmt -w .`, and `go test ./...` is the registry's test command.

## License

MIT

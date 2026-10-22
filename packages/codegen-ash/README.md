# @appling/codegen-ash

Appling code generation extension for [Ash](https://ash-hq.org) on Elixir. It turns an Appling model into a draft Ash project with AshPostgres, using Ash's own generators through [Igniter](https://hexdocs.pm/igniter).

```json
{
  "generate": [
    { "extension": "@appling/codegen-ash", "out": "build/shop" }
  ]
}
```

The project is created next to the output folder with `mix igniter.new <name>`, so the project name (the `name` option, or by default the output folder's name) must be the output folder's name.

Requires Elixir 1.17 or later and the `igniter_new` archive (`mix archive.install hex igniter_new`).

## What it generates

| Model | Ash |
|---|---|
| project | `mix igniter.new <name> --install ash,ash_postgres` |
| `module` | `mix ash.gen.domain <App>.<Module>` |
| `enum` | `mix ash.gen.enum` |
| `value` | an embedded resource |
| `entity` | `mix ash.gen.resource` with a UUID primary key, default actions, timestamps and the Postgres data layer |
| field types | `:string`, `:integer`, `:decimal`, `:boolean`, `:date`, `:utc_datetime_usec`, `:duration`, `:uuid`; enums and value types by module; lists as arrays |
| entity field | a `belongs_to` relationship, added after all resources exist |
| `unique`, `?`, `default` | an identity, `allow_nil?`, `default` |
| derived field | a calculation with an Ash expression |
| `invariant` | a validation built from `compare`, `attribute_equals`, `attribute_in`, `present`, `all`, `any` and `negate` |

What cannot be translated becomes a registry task: many to many relationships, calculations over embedded lists, invariants over calculations or other resources, and policies.

## License

MIT

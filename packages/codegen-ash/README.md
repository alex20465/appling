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
| `action` on an entity | an update action: arguments for inputs, validations for preconditions and guards, `set_attribute` or `atomic_update` changes, and `transition_state` |
| `machine` | an AshStateMachine section; transitions on an event get an update action named after the event |
| scheduled `job` | an AshOban trigger with `where` and `scheduler_cron`; `now - duration("720h")` becomes `ago(720, :hour)` |
| `query` | a read action with filter, sort and offset pagination |
| computed projection field | a calculation on the source resource |
| `interface rest` | AshJsonApi routes on the domain (`index` for queries with `default_fields` from picks, `patch` for update actions), a JSON:API router, and Bandit started by the application on port 4000, without Phoenix |
| rules | skipped ExUnit tests in `test/<app>/<module>/<resource>_test.exs` for invariants, policies, transitions and preconditions; writing their bodies is a registry task |

The project ends with `mix ash.codegen initial_resources`, so migrations and resource snapshots start with the generated resources.

`appling generate --migrate` changes the attribute in the resource, writes an Ecto migration that renames, modifies or removes the column, and updates the resource snapshots with `mix ash_postgres.generate_migrations --snapshots-only`, so later `mix ash.codegen` runs do not see a rename as a drop and an add. Renamed entities and enum values become registry tasks.

Machines, scheduled jobs and REST interfaces add `ash_state_machine`, `ash_oban`, and `ash_json_api` with `bandit` to the project.

What cannot be translated becomes a registry task: many to many relationships, calculations over embedded lists, invariants and preconditions over calculations or other resources, policies, events (Ash notifiers), externals and use cases (generic actions or Reactor), effects that create rows or emit events, jobs on events, authentication, rate limits and CORS.

## License

MIT

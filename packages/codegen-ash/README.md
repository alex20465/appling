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
| project | `mix igniter.new <name> --install ash,ash_postgres`, plus `simple_sat` when the model has policies |
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
| `query` | a read action with its inputs as arguments, filter, sort and offset pagination; a filter that does not translate reads nothing (`filter expr(false)`) until written |
| computed projection field | a calculation on the source resource |
| `actor` | bound with `is`: the entity's resource holds its fields and a private `roles` attribute limited to the roles its actors carry; a `human` actor without `is`: a resource of its own with its fields and `roles`; a `system` or `service` actor without `is`: a struct whose `roles` are its roles; `actor.is(Actor)` becomes a check matching its record |
| `role` | an `Ash.Policy.SimpleCheck` `<App>.<Module>.Checks.<Role>` with one clause per actor record that carries the role; the roles a condition names call their checks, the rest of the condition is a calculation `:<role>?` on the actor resource |
| `tenant` | attribute multitenancy (`strategy :attribute`) on every resource with a relationship to the tenant's entity, `global? true` on actor resources; `tenant` in expressions becomes `^tenant()` |
| `policy` | `Ash.Policy.Authorizer` policies: `action_type(...)` or `always()` for entity policies, `field_policy` for `fields` (plus a catch-all `field_policy :*`; a calculation it names is public, a derived field without one waits for its calculation task), `action(:name)` for actions and queries; each `\|\|` branch becomes `authorize_if`, a branch with `&&` becomes `forbid_unless` checks followed by `authorize_if`; conditions become `expr` checks with `^actor(...)` and records compared by id. Once the model has a policy, every resource lists the authorizer and denies what no policy covers (a resource without policies gets `policy always()` with `forbid_if always()`), an untranslated condition forbids until written, and resources with jobs get an AshOban bypass |
| `interface rest` | AshJsonApi routes on the domain (`index` for queries with `default_fields` from picks, `patch` for update actions), served by Phoenix under `/api/json` when the model has pages, otherwise by a JSON:API router that Bandit serves on port 4000 |
| `page`, `navigation`, `messages` | Phoenix LiveViews with lists, details, AshPhoenix forms and action buttons, navigation links and column labels; models with pages need the `phx_new` archive |
| `does` | `@moduledoc` of resources and embedded resources, `description` of attributes, and a registry task |
| rules | skipped ExUnit tests in `test/<app>/<module>/<resource>_test.exs` for invariants, policies, transitions and preconditions; invariants that become validations get changeset test bodies where the simulator proves a valid and a violating input, transitions get update changeset bodies on a record struct (AshStateMachine's state check, no database), entity policies get `Ash.can?` bodies on an actor struct for actors their `actor.is(...)` checks decide, writing every other body is a registry task |

The project ends with `mix ash.codegen initial_resources`, so migrations and resource snapshots start with the generated resources.

`appling generate --migrate` changes the attribute in the resource, writes an Ecto migration that renames, modifies or removes the column, and updates the resource snapshots with `mix ash_postgres.generate_migrations --snapshots-only`, so later `mix ash.codegen` runs do not see a rename as a drop and an add. Renamed entities and enum values become registry tasks.

Machines, scheduled jobs and REST interfaces add `ash_state_machine`, `ash_oban`, and `ash_json_api` with `bandit` to the project.

What cannot be translated becomes a registry task: many to many relationships, calculations over embedded lists, invariants and preconditions over calculations or other resources, policies with more than one `&&` branch and field policies that follow relationships (both deny until written), writes of field policies, policies of use cases and of actions without an entity, resources that reach the tenant only through relationships, events (Ash notifiers), externals and use cases (generic actions or Reactor), effects that create rows or emit events, jobs on events, authentication, rate limits and CORS, webhook endpoints and the vendor side setup (registering webhooks, issuing tokens with a role claim). Settings and secrets of externals are read from the environment in `config/runtime.exs` (a missing secret stops the app through `System.fetch_env!`) and listed in `.env.example`.

## License

MIT

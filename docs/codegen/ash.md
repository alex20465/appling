---
title: Ash target
description: What @appling/codegen-ash generates from a model, how it uses Ash's own generators through Igniter, and how to run the generated Elixir project.
---

`@appling/codegen-ash` turns a model into a draft [Ash](https://ash-hq.org) 3 project on Elixir with AshPostgres. It creates the project and every domain, enum and resource with Ash's own generators through [Igniter](https://hexdocs.pm/igniter), then patches the generated modules with what the generators do not cover: defaults, identities, calculations, validations, actions, state machines, background jobs, a JSON:API and, when the model has pages, Phoenix LiveViews.

## Requirements

| Tool | Notes |
|---|---|
| Elixir 1.17 or later | `appling generate` checks `mix --version`. |
| `igniter_new` | The Mix archive behind `mix igniter.new`. Install it with `mix archive.install hex igniter_new`; `appling generate` checks `mix help igniter.new`. |
| `phx_new` | Only for models with pages, which become a Phoenix application. Install it with `mix archive.install hex phx_new`; `appling generate` checks `mix help phx.new`. |
| Network | Igniter fetches the Hex packages. |
| PostgreSQL | Needed to run the generated project, not to generate it. |

## Configuration

```json
{
  "generate": [
    { "extension": "@appling/codegen-ash", "out": "build/shop" }
  ]
}
```

| Option | Meaning |
|---|---|
| `name` | The project name. Default: the name of the output folder. |

> [!IMPORTANT]
> `mix igniter.new <app>` runs in the parent of the output folder and creates the project in a folder named after the app there, so the app name must equal the output folder's name. The app name is the project name in lower case, with every character other than letters, digits and `_` replaced by `_`. Use an output folder whose name already has that form, such as `build/shop` or `build/shop_api`, and leave `name` unset.

The app name also sets the Elixir module prefix: `shop` becomes `Shop`, `shop_api` becomes `ShopApi`.

## Project setup

| Step | Command |
|---|---|
| Project | `mix igniter.new <app> --install ash,ash_postgres --yes --no-git`, adding `simple_sat` (the SAT solver Ash policies need, in pure Elixir) when the model has policies, `ash_state_machine` when it has machines and `ash_oban` when it has scheduled jobs |
| Phoenix | when the model has pages, `igniter.new` also gets `--with phx.new --with-args=--no-install` and installs `ash_phoenix`, plus `ash_json_api` when the model has a REST interface |
| JSON:API | `mix igniter.install ash_json_api,bandit --yes` when the model has a REST interface and no pages |
| Migrations | `mix ash.codegen initial_resources`, as the very last step |

Because the project ends with `ash.codegen`, its migrations and resource snapshots start with the generated resources. [`appling generate --migrate`](migrations.md#ash) continues from there.

## Phases

Ash's generators work on modules that must already exist, so the extension spreads its steps over phases:

| Phase | Runs |
|---|---|
| 0 | Project setup, `ash.gen.domain`, `ash.gen.enum`, `ash.gen.resource`, embedded resources and test files |
| 1 | `belongs_to` relationships, once every resource exists |
| 2 | Every patch of a generated module, after the last `mix` command, so expressions may follow relationships, and the role and actor checks, which match the actor resources' structs |
| 3 | `mix ash.codegen initial_resources` |

## Model to Ash

Modules are named `<App>.<Module>`, with nested modules as `<App>.<A>.<B>`; a type is `<App>.<Module>.<Name>`. The resource `Order` of the module `sales` lives in `lib/shop/sales/order.ex`. Action names are the snake case form of the element name, such as `:place_order`.

| Model | Ash |
|---|---|
| `module` | `mix ash.gen.domain <App>.<Module>` |
| `enum` | `mix ash.gen.enum <App>.<Module>.<Enum> <values>` |
| `value` | an embedded resource (`data_layer: :embedded`) with public attributes |
| `entity` | `mix ash.gen.resource` with the domain, default actions `read,create,update,destroy`, a UUID primary key `id`, the stored fields as public attributes, the Postgres data layer and timestamps |
| field of an entity type | a `belongs_to` relationship, added in phase 1 |
| field of a list of entities | a task for a many to many relationship |
| `unique` | an identity `:unique_<field>` |
| `?` | the attribute is not `required` |
| `default` | `default` on the attribute for constants and enum values; `now` becomes `&DateTime.utc_now/0` |
| derived field | a calculation `calculate :<field>, <type>, expr(...)` |
| `invariant` | a validation built from Ash's builtin validations (`compare`, `attribute_equals`, `attribute_does_not_equal`, `attribute_in`, `present`, `absent`, `all`, `any`, `negate`) with the label as message; a test |
| `policy` | an Ash policy or field policy (see [policies](#policies)); a test when it is on an entity |
| `action` on an entity | an update action (see [actions](#actions)) |
| `action` without an entity | a task to write a generic action |
| `machine` | an AshStateMachine section (see [state machines](#state-machines)) |
| scheduled `job` | an AshOban trigger (see [jobs](#jobs)) |
| `query` | a read action with `filter`, `sort` and offset pagination; its inputs become `argument`s (`allow_nil?` for optional ones, the id for an entity) that the filter reads as `^arg(:name)`, and `since == null` becomes `is_nil(^arg(:since))`. A filter that does not translate becomes `filter expr(false)` plus a task, so the action reads nothing until the filter is written |
| computed projection field | a calculation on the source resource |
| `interface rest` | AshJsonApi routes and a router served by Bandit (see [JSON:API](#jsonapi)) |
| `actor` | the record that acts: the resource of its `is` entity, a resource of its own or a struct (see [actors](#actors)) |
| `role` | an `Ash.Policy.SimpleCheck` module `<App>.<Module>.Checks.<Role>` in `lib/<app>/<module>/checks/<role>.ex` (see [roles](#roles)) |
| `tenant` | attribute multitenancy on the resources that belong to the tenant's entity (see [tenants](#tenants)) |
| `event`, `external`, `usecase` | tasks: an Ash notifier, a client module or generic actions, a Reactor or generic action |
| `setting`, `secret` of an external | a `config` line in `config/runtime.exs` read from the environment and a line in `.env.example` (see [settings and secrets](#settings-and-secrets)) |
| `interface webhook` | tasks: register each endpoint at the vendor, receive it and verify its signature |
| `scenario` | an ExUnit test in `test/<app>/<module>/scenarios_test.exs` (see [scenarios](#scenarios)) |

### Types

| Appling type | Ash type |
|---|---|
| `String`, `Text`, `File` | `:string` |
| `Int` | `:integer` |
| `Decimal`, `Money` | `:decimal` |
| `Bool` | `:boolean` |
| `Date` | `:date` |
| `DateTime` | `:utc_datetime_usec` |
| `Duration` | `:duration` |
| `Uuid` | `:uuid` |
| an enum or value type | its module, such as `Shop.Sales.OrderStatus` |
| a list | `{:array, type}` |

### Actions

An action on an entity becomes an update action of its resource with `require_atomic? false`; one that deletes its own record (`delete self`) without a transition becomes a destroy action. Its inputs become `argument`s. Preconditions and guards become `validate` lines when they translate to builtin validations. `set` effects become `set_attribute` for constants and `now`, or `atomic_update` with an expression. A transition of the state machine adds `change transition_state(:<state>)`.

### State machines

A machine becomes an `AshStateMachine` section on the resource of its state field: `initial_states` and `default_initial_state` from the field's default (or the first enum value), `state_attribute`, and one `transition` per transition. Transitions on an event get an update action named after the event, and calling it when the event happens is a task.

### Jobs

A scheduled job becomes an `AshOban` trigger on the resource of its action: the action, a read action `<job>_targets` with keyset pagination that the scheduler pages through, the filter as `where`, the cron as `scheduler_cron`, a queue `<resource>_<job>` that is added to the Oban `queues` in `config/config.exs`, and explicit worker and scheduler module names. `now - duration("720h")` becomes `ago(720, :hour)`. When the model has policies, the resource's policies start with a bypass for AshOban, so the job runs as the system (see [policies](#policies)).

This is the `Order` resource of the [example](../../examples/sales.appling) after the patches (attributes, relationships and policies omitted):

```elixir
defmodule Shop.Sales.Order do
  use Ash.Resource, otp_app: :shop, domain: Shop.Sales, data_layer: AshPostgres.DataLayer,
    extensions: [AshJsonApi.Resource, AshOban, AshStateMachine]

  actions do
    defaults [:read, :destroy]

    update :place_order do
      require_atomic? false
      change set_attribute(:placed_at, &DateTime.utc_now/0)
      change transition_state(:placed)
    end

    update :cancel do
      require_atomic? false
      argument :reason, :string, allow_nil?: true
      validate negate(present(:paid_at)), message: "invalid transition"
      change transition_state(:cancelled)
    end

    update :payment_received do
      require_atomic? false
      change transition_state(:paid)
    end

    read :expire_drafts_targets do
      pagination keyset?: true, required?: false
    end

    read :open_orders do
      filter expr(status in [:placed, :paid])
      prepare build(sort: [placed_at: :desc])
      pagination offset?: true, default_limit: 50, required?: false
    end
  end

  state_machine do
    initial_states [:draft]
    default_initial_state :draft
    state_attribute :status

    transitions do
      transition :place_order, from: [:draft], to: :placed
      transition :payment_received, from: [:placed], to: :paid
      transition :cancel, from: [:draft, :placed], to: :cancelled
    end
  end

  oban do
    triggers do
      trigger :expire_drafts do
        action :cancel
        read_action :expire_drafts_targets
        queue :order_expire_drafts
        where expr((status == :draft) and (created_at < ago(720, :hour)))
        scheduler_cron "0 3 * * *"
        worker_module_name Shop.Sales.Order.AshOban.Worker.ExpireDrafts
        scheduler_module_name Shop.Sales.Order.AshOban.Scheduler.ExpireDrafts
      end
    end
  end

  json_api do
    type "order"
  end
end
```

### Pages

When the model has pages, the project is a [Phoenix](https://phoenixframework.org) application and every page becomes a LiveView in `lib/<app>_web/live/<page>_live.ex`, routed in `lib/<app>_web/router.ex` next to the home page. Route parameters such as `{id}` become `:id`.

| Component | LiveView |
|---|---|
| `list` | the query's read action, paginated when the query has a page size, in a `.table` with one column per projection field; the query's inputs come from the page's parameters through `Ash.Query.for_read` |
| `detail` | `Ash.get!` of the record in the route's `:id`, in a `.list` |
| `form` | an `AshPhoenix.Form` for the action on the record in `:id`, with an input per action input |
| row and detail actions | a button per action without required inputs, running it and reporting the outcome as a flash |

Columns read stored attributes directly and load derived and computed fields through their calculations. Column titles come from the module's `messages` (`<Projection>.<field>`), otherwise from the field name. The module's navigation becomes links above every page of the module.

Flows, navigation items to pages that need an id, actions with required inputs offered on lists, and fields that do not translate become tasks.

### JSON:API

A REST interface becomes [AshJsonApi](https://hexdocs.pm/ash_json_api) routes. With pages it is served through Phoenix, otherwise through Bandit:

- Each resource with an endpoint gets the `AshJsonApi.Resource` extension and a `json_api` type.
- The domain gets the `AshJsonApi.Domain` extension and a `base_route "/"` per resource. `GET` on a query becomes an `index` route, with `default_fields` from `picks`; AshJsonApi passes the path parameters and the query string to the read action's arguments. `POST`, `PUT` or `PATCH` on an action of an entity, with `{id}` in the path, becomes a `patch` route; `POST` and `PUT` are served as `PATCH`, which a task notes.
- With pages, the domains are added to the `<App>Web.AshJsonApiRouter` that the AshJsonApi installer creates, which the Phoenix router forwards under `/api/json`, with Swagger UI at `/api/json/swaggerui`.
- Without pages, `lib/<app>/api_router.ex` defines `<App>.ApiRouter` with `use AshJsonApi.Router` over the domains and an OpenAPI document at `/open_api`, and the application starts `{Bandit, plug: <App>.ApiRouter, port: 4000}`.

Path parameters such as `{id}` become `:id`. Authentication, rate limits and CORS are tasks.

### Settings and secrets

Each `setting` and `secret` of an external becomes a `config` line in `config/runtime.exs` under the external's module, read from the environment variable `<EXTERNAL>_<KEY>` in upper snake case, so the code reads it with `Application.get_env(:shop, Shop.Sales.Clerk)[:secret_key]`:

```elixir
config :shop, Shop.Sales.Clerk, max_sessions: System.get_env("CLERK_MAX_SESSIONS") |> then(&(&1 && String.to_integer(&1)))
config :shop, Shop.Sales.Clerk, test_mode: System.get_env("CLERK_TEST_MODE") in ~w(1 true yes)
config :shop, Shop.Sales.Clerk, secret_key: System.fetch_env!("CLERK_SECRET_KEY")
```

A missing setting is `nil` (`false` for a `Bool`). A `secret` is required: `System.fetch_env!` stops the app at startup with `could not fetch environment variable "CLERK_SECRET_KEY" because it is not set`. `runtime.exs` runs on every start, `mix test` included, so fill `.env` from `.env.example` and load it into the environment. While generating, Appling runs its own `mix ash.codegen` with a placeholder for each secret.

`.env.example` lists every key with an empty value, under a comment with its kind, its external and its `does` text. The setup on the vendor's side becomes [registry](registry.md) tasks: for every endpoint of an `interface webhook ... from <External>` one to register it at the vendor and one to receive it and verify its signature, and for `auth <scheme> from <External>` one to let the vendor issue the tokens, naming the model's roles for the role claim.

### Tests

Invariants, policies on entities, transitions and actions with preconditions get skipped ExUnit tests in the test module of their resource, `test/<app>/<module>/<resource>_test.exs`. Each test is tagged with a skip reason that names its registry entry, and writing the bodies is a task of that entry. See [test skeletons](registry.md#test-skeletons).

```elixir
@tag skip: "registry task: sales.OrderFlow.transition[draft->placed]"
test "transition draft -> placed moves from allowed states"
```

An invariant that becomes a validation gets test bodies when the model says everything they need. Both tests build a changeset for the resource's `create` action with `Ash.Changeset.for_create(..., authorize?: false)`, which runs the validations without a database. The input has a sample value for every required attribute without a default (`"<attribute>-1"` for strings, `1` for numbers, `false`, the current date or time, one hour, a new UUID, the first enum literal). `holds for valid records` asserts that this changeset is valid; `rejects violations` sets one attribute the condition compares to a value (`-1`, `0` or `1000000` for numbers, either boolean, each enum literal) and refutes it.

```elixir
test "invariant positive rejects violations" do
  changeset = Ash.Changeset.for_create(Shop.Shop.Item, :create, %{code: "code-1", quantity: -1}, authorize?: false)
  refute changeset.valid?
end
```

A case only gets a body when the Appling simulator proves that the sample input satisfies every translated invariant (for `rejects violations`, also that the changed input breaks this invariant and no other, with every attribute the condition compares set, since the validations pass on nil). Resources with a required relationship, a required value type or file, a default that does not translate, and actor resources keep both tests skipped, as do invariants that stay a task.

A transition gets test bodies the same way. Both tests build a record struct from that sample input (with the defaults filled in and the state field set) and a changeset for the update action AshStateMachine runs the transition with, with `Ash.Changeset.for_update(record, :<action>, ..., authorize?: false)` and a sample value for every required argument. AshStateMachine checks the state when the changeset is built, so neither test needs a database. `moves from allowed states` starts from a state the transition leaves and asserts that the changeset is valid; `refuses other states` starts from a state no transition of that action leaves and asserts AshStateMachine's `NoMatchingTransition` error.

```elixir
test "transition draft -> placed refuses other states" do
  record = struct!(Shop.Shop.Order, %{code: "code-1", total: 0, status: :placed})
  changeset = Ash.Changeset.for_update(record, :place, %{}, authorize?: false)
  refute changeset.valid?
  assert Enum.any?(changeset.errors, &match?(%AshStateMachine.Errors.NoMatchingTransition{}, &1))
end
```

`moves from allowed states` only gets a body when the simulator proves the action's preconditions and guards true on that record, and the translated invariants true after the transition, with no effect setting a field they read. An action whose transitions lead to more than one state (picking the target is a task), an action on another entity, a required argument without a sample value (a record, a value type, a file) and a resource without a sample input keep both tests skipped; a state machine where every state leads on keeps `refuses other states` skipped. Precondition tests stay skipped.

A policy on a whole entity gets test bodies that ask its authorizer with `Ash.can?` for the resource's default action of each operation it covers other than reads (`create`, `update`, `destroy`), with `maybe_is: false`. Reads are left out: Ash allows a read and filters its records, so `Ash.can?` without records answers true for every actor, and a policy on reads only keeps its tests skipped. The actor is a struct: a record of the actor's resource with the actor's own roles, or the struct of a system or service actor. This needs no database as long as the checks that decide are `actor.is(...)` checks, which are `Ash.Policy.SimpleCheck`s. The generator walks the policy's checks in Ash's order (`authorize_if` stops when its check holds, `forbid_unless` stops when it fails), and an actor is tested only when the walk ends before an `expr` check or a role with a condition, and the simulator gives the same verdict. `allows permitted actors` asserts every operation that this policy and every other policy of the entity on that operation let the actor do. `denies other actors` refutes every operation of the policy for an actor it keeps out.

```elixir
test "policy[create,delete] allows permitted actors" do
  actor = %Shop.Crm.Employee{roles: [:clerk]}
  assert Ash.can?({Shop.Sales.Order, :create}, actor, maybe_is: false)
  assert Ash.can?({Shop.Sales.Order, :destroy}, actor, maybe_is: false)
end
```

A case without such an actor stays skipped. So do field policies and the policies of resources partitioned by a tenant.

### Scenarios

Each [scenario](../language/scenarios.md) becomes one test in the module's scenario test file, `test/<app>/<module>/scenarios_test.exs`. The module is `<App>.<Module>.ScenariosTest`; it is not async and checks out a database sandbox (`Ecto.Adapters.SQL.Sandbox.start_owner!`) for each test, so `mix test` needs the PostgreSQL server of the repo configuration.

| Scenario | Test |
|---|---|
| `given` row | `Ash.Seed.seed!(<Resource>, %{...})`, which writes the row without actions, validations or policies and sets the attribute defaults. The given values come first, then a sample for every required attribute the scenario does not give (`"<attribute>-<row>"` for strings, the row number for a unique integer, a map of samples for a value type, otherwise the samples of the invariant tests), and `[]` for lists. A relationship is the related row's id (`customer_id: acme.id`), so it names an earlier row. A row of a partitioned resource is seeded with `tenant:` |
| binding name | a variable holding the seeded row |
| `as` | the actor: a role means the first actor that holds it. A resource actor is seeded with its field values, samples and its declared `roles`; a struct actor is `%<Module>{...}` with its roles |
| `when` | `Ash.update(row, %{inputs}, action: :<action>, actor: actor)` on the update action of the action, with the row's tenant; without `as`, `authorize?: false`, as a system calls it. |
| `then { ... }` | `assert {:ok, _}`, then every row the checks read is read back with `Ash.reload!` (loading the calculations they name), and each check becomes an `assert`: attributes, relationships compared by id, enum values as atoms, decimals through `Decimal.compare` |
| `then fails E` | `assert {:error, error}` and that the error message contains the name of `E`, the message of the precondition's validation |
| `then fails` | `assert {:error, _}` |
| `then refused` | `assert {:error, %Ash.Error.Forbidden{}}` |

```elixir
# A clerk cancels a draft order
test "scenario ClerkCancelsDraft" do
  acme = Ash.Seed.seed!(Shop.Crm.Account, %{name: "Acme", email: "email-1"})
  order = Ash.Seed.seed!(Shop.Sales.Order, %{reference: "A-1", customer_id: acme.id, lines: [], created_at: DateTime.utc_now()}, tenant: acme.id)
  actor = Ash.Seed.seed!(Shop.Crm.Employee, %{roles: [:clerk]})
  assert {:ok, _} = Ash.update(order, %{reason: "changed mind"}, action: :cancel, actor: actor, tenant: acme.id)
  order = Ash.reload!(order, authorize?: false)
  assert order.status == :cancelled
end
```

A scenario only gets a body when the generated project does what the model says, which the extension checks with the Appling simulator: the precondition and guard validations of the action and the state check of AshStateMachine must pass on the given rows (fail, for `then fails`, where the precondition of `E` must translate and be false), the translated invariants must hold after the call without reading a field the action sets, and for a call with an actor every policy that guards it must translate, as must the role checks it names. For `then { ... }`, every `set` of the action must translate too. Ash checks the policies only after the validations, so a refused scenario also needs the validations to pass. Every other scenario stays a skipped test, and writing it is a task of its registry entry that says why, for example a call to a use case or an action without an entity, a given row with a list of entities, a required relationship the scenario does not give, an `emitted` check (events are tasks), or a check that does not translate.

Scenario tests replace the guessed tests of what they cover: an action that a scenario's `when` runs gets no precondition tests, and the transitions it triggers get no transition tests, so their registry entries gain no task for them.


## Actors

An actor is the record Ash gets as `actor:`. Where it lives depends on the declaration:

| Actor | Record |
|---|---|
| bound with `is Entity` | the entity's resource; the actor's fields become its attributes and relationships |
| `human` without `is` | a resource of its own, `<App>.<Module>.<Actor>`, with its fields, a UUID primary key and the Postgres data layer |
| `system` or `service` without `is` | a struct `%<App>.<Module>.<Actor>{}` with its fields (relationships as `<field>_id`) and `roles` set to the roles it declares |

Every actor resource gets a private `roles` attribute (`{:array, :atom}`, not public, so nobody assigns roles to themselves through the API), empty by default and limited to the roles its actors carry with `constraints items: [one_of: [...]]`.

`actor.is(Actor)` becomes a check `<App>.<Module>.Checks.<Actor>` that matches the actor's record. When several actors are bound to the same entity, their records look the same, and telling them apart is a task.

## Roles

Each role becomes a check with one `match?` clause per actor record that carries the role. The clause holds when the record has the role in `roles`, the roles the condition names with `actor.is` hold (their checks are called), and the rest of the condition holds, which becomes a calculation `:<role>?` on the actor resource:

```appling check
module ops {
  entity User {
    disabled: Bool default false
    active: Bool = !disabled
  }
  role Operator { actor.active }
  actor human Employee is User roles Operator

  entity Order {
    note: String?
    policy read { actor.is(Operator) }
  }

  action Cancel on Order {
    policy { actor.is(Operator) }
  }
}
```

```elixir
# lib/shop/ops/checks/operator.ex
defmodule Shop.Ops.Checks.Operator do
  use Ash.Policy.SimpleCheck

  @impl true
  def describe(_opts), do: "actor is Operator"

  @impl true
  def match?(%Shop.Ops.User{} = actor, context, _opts) do
    actor = Ash.load!(actor, :operator?, authorize?: false, tenant: context.subject.tenant)
    :operator in (actor.roles || []) and actor.operator?
  end

  def match?(_actor, _context, _opts), do: false
end
```

A record that cannot carry a role the condition names, or lacks a field it reads, gets no clause, so the check is false for it. A role that no actor carries is a check that is always false. Role conditions that do not translate, and conditions with more than `actor.is` on a struct actor, are tasks.

## Tenants

A tenant becomes Ash [attribute multitenancy](https://hexdocs.pm/ash/multitenancy.html). Every resource with a relationship to the tenant's entity is partitioned by that relationship:

```elixir
multitenancy do
  strategy :attribute
  attribute :customer_id
end
```

Pass the id of the tenant record as `tenant:` to every query and change. Actor resources also get `global? true`, so an actor can be looked up before its tenant is known. In expressions, `tenant` becomes `^tenant()`. Resources that reach the tenant only through other relationships, such as an order line through its order, and resources with several relationships to tenant entities are tasks.

## Policies

Policies become `Ash.Policy.Authorizer` policies on the resource, which then lists the authorizer:

| Policy on | Ash |
|---|---|
| an entity, with operations | `policy action_type(:read)`, a list for several, `delete` becomes `:destroy` |
| an entity, without operations | `policy always()` |
| an entity, with `fields` | `field_policy :discount` or `field_policy [:discount, :note]` in `field_policies`, plus one `field_policy :*` that allows every other field |
| an action on an entity | `policy action(:<action>)` on the entity's resource |
| a query | `policy action(:<query>)` on the read action of the query |

Each `||` branch of the condition grants: a branch with one check becomes `authorize_if`, a branch with `&&` becomes `forbid_unless` for each check but the last and `authorize_if` for the last, after every single check branch. `actor.is(X)` is the check module of `X`; any other condition is an `expr` check. In those, `actor.<field>` becomes `^actor(:<field>)`, and records compare by id: `customer == actor.account` becomes `customer_id == ^actor(:account_id)`, `this` becomes `id`.

This is the `Order` resource of the [example](../../examples/sales.appling):

```elixir
policies do
  policy action_type(:read) do
    authorize_if Shop.Crm.Checks.Clerk
    forbid_unless Shop.Sales.Checks.Customer
    authorize_if expr(customer_id == ^actor(:account_id))
  end

  policy action_type([:create, :destroy]) do
    authorize_if Shop.Crm.Checks.Clerk
  end

  policy action_type(:update) do
    authorize_if Shop.Crm.Checks.Clerk
    forbid_unless Shop.Sales.Checks.Customer
    forbid_unless expr(customer_id == ^actor(:account_id))
    authorize_if expr(status == :draft)
  end

  policy action(:place_order) do
    forbid_unless Shop.Sales.Checks.Customer
    authorize_if expr(customer_id == ^actor(:account_id))
  end

  policy action(:cancel) do
    authorize_if Shop.Crm.Checks.Clerk
  end
end
```

Its `policy read fields total` generates no field policy yet: `total` sums a list, so it has no calculation, and Ash field policies name only fields the resource has. The task of the field, `add the calculation total = ..., public?: true, and add it to the field policy of sales.Order.policy[read fields total]: ...`, carries the condition.

Ash forbids an action that no policy applies to on a resource with the authorizer, and requires every policy that applies to an action to pass. The effective policy is the conjunction of the policies along the path, so an action needs both the entity's `update` policy and its own.

Once the model has any policy, nothing is open by default, as in [Django](django.md#access):

- Every resource lists the authorizer, also resources without policies and the resources of human actors. A resource that no policy applies to gets one policy that forbids every action, so the default `read`, `create`, `update` and `destroy` actions that `ash.gen.resource` creates are closed:

  ```elixir
  policies do
    policy always() do
      forbid_if always()
    end
  end
  ```

- On a resource with policies, the default actions that no policy covers, such as `:destroy` when only `read` and `update` have policies, are forbidden by Ash.
- A policy whose condition does not translate becomes its policy with `forbid_if always()` in place of the checks, and a task to write them, so it denies until the task is done.
- A resource with a [job](#jobs) starts its policies with a bypass, so the AshOban scheduler and worker run as the system, as jobs do in the model:

  ```elixir
  bypass AshOban.Checks.AshObanInteraction do
    authorize_if always()
  end
  ```

A model without any policy generates no authorizer, and every action stays open.

Callers pass the actor: the JSON:API takes it from the connection (`Ash.PlugHelpers.set_actor/2`), the generated LiveViews pass none, so their reads and actions on closed resources are forbidden until a signed in actor is passed with `actor:`.

Ash field policies guard reads only: a field policy that also names `create`, `update` or `delete`, or names no operation, guards reads and leaves the writes a task. They name public attributes and calculations only: the calculation of a derived field that a field policy names is `public?: true`, a derived field without a calculation is left out until its calculation is written (its task names the policy), and a relationship is a task. A field policy that follows a relationship (Ash field policies cannot) does not translate, so it forbids. Field policies on other operations only, policies of queries whose filter does not translate, of use cases and of actions without an entity stay tasks without a policy. The policy tests get bodies where `actor.is(...)` checks decide them (see [tests](#tests)); writing the others is a task.

## Descriptions

A [`does`](../language/descriptions.md) text goes into the generated code as documentation:

| Element | Becomes |
|---|---|
| Entity | `@moduledoc` of the resource |
| Value type | `@moduledoc` of the embedded resource |
| Entity field | `description` of the attribute |

Each text is also a [registry task](registry.md#status), which carries it for every other element.

## What becomes a task

Whatever cannot be translated is listed in the [registry](registry.md):

- many to many relationships, and derived or default fields of value types
- calculations over lists, and derived fields or defaults that do not translate
- invariants, preconditions and guards over calculations, relationships or other resources, and guards when an action has several transitions
- effects that create rows or emit events, loops (`for`), updates and deletes of related records, `delete self` in an action with a transition, and actions with several target states
- actions with `consistency eventual`, and actions without an entity
- policies that do not translate, which deny until written, and writes of field policies (see [policies](#policies)), role conditions that do not translate, telling apart actors bound to the same entity, resources that reach the tenant only through relationships, events, externals and use cases
- jobs on events, and jobs whose filter does not translate
- authentication, rate limits and CORS of interfaces, and endpoints that do not fit the route patterns
- flows, and interfaces with a protocol other than `rest`
- scenarios whose test the generated project cannot pass yet (see [scenarios](#scenarios))

## Run the generated project

```sh
cd build/shop
mix ash.setup
iex -S mix
mix test
```

`mix ash.setup` creates the database and runs the migrations; it needs a PostgreSQL server that matches the repo configuration in `config/`. Without pages, starting the application starts Bandit, so the JSON:API answers on `http://localhost:4000`, for example `GET /orders`. With pages, run `mix phx.server` instead: the pages answer on `http://localhost:4000`, for example `/orders`, and the JSON:API under `/api/json`. `mix test` is also the command the registry stores, so the AI tools run it after each task.

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
| Project | `mix igniter.new <app> --install ash,ash_postgres --yes --no-git`, adding `ash_state_machine` when the model has machines and `ash_oban` when it has scheduled jobs |
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
| 2 | Every patch of a generated module, after the last `mix` command, so expressions may follow relationships |
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
| `policy` | a task to add an Ash policy; a test when it is on an entity |
| `action` on an entity | an update action (see [actions](#actions)) |
| `action` without an entity | a task to write a generic action |
| `machine` | an AshStateMachine section (see [state machines](#state-machines)) |
| scheduled `job` | an AshOban trigger (see [jobs](#jobs)) |
| `query` | a read action with `filter`, `sort` and offset pagination |
| computed projection field | a calculation on the source resource |
| `interface rest` | AshJsonApi routes and a router served by Bandit (see [JSON:API](#jsonapi)) |
| `event`, `external`, `usecase`, `role` | tasks: an Ash notifier, a client module or generic actions, a Reactor or generic action, the role on the actor resource |
| experience layer, actors, tenants | not generated; `todo` entries in the [registry](registry.md) |

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

An action on an entity becomes an update action of its resource with `require_atomic? false`. Its inputs become `argument`s. Preconditions and guards become `validate` lines when they translate to builtin validations. `set` effects become `set_attribute` for constants and `now`, or `atomic_update` with an expression. A transition of the state machine adds `change transition_state(:<state>)`.

### State machines

A machine becomes an `AshStateMachine` section on the resource of its state field: `initial_states` and `default_initial_state` from the field's default (or the first enum value), `state_attribute`, and one `transition` per transition. Transitions on an event get an update action named after the event, and calling it when the event happens is a task.

### Jobs

A scheduled job becomes an `AshOban` trigger on the resource of its action: the action, a read action `<job>_targets` with keyset pagination that the scheduler pages through, the filter as `where`, the cron as `scheduler_cron`, a queue `<resource>_<job>` that is added to the Oban `queues` in `config/config.exs`, and explicit worker and scheduler module names. `now - duration("720h")` becomes `ago(720, :hour)`.

This is the `Order` resource of the [example](../../examples/sales.appling) after the patches (attributes and relationships omitted):

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
| `list` | the query's read action, paginated when the query has a page size, in a `.table` with one column per projection field |
| `detail` | `Ash.get!` of the record in the route's `:id`, in a `.list` |
| `form` | an `AshPhoenix.Form` for the action on the record in `:id`, with an input per action input |
| row and detail actions | a button per action without required inputs, running it and reporting the outcome as a flash |

Columns read stored attributes directly and load derived and computed fields through their calculations. Column titles come from the module's `messages` (`<Projection>.<field>`), otherwise from the field name. The module's navigation becomes links above every page of the module.

Flows, navigation items to pages that need an id, actions with required inputs offered on lists, and fields that do not translate become tasks.

### JSON:API

A REST interface becomes [AshJsonApi](https://hexdocs.pm/ash_json_api) routes. With pages it is served through Phoenix, otherwise through Bandit:

- Each resource with an endpoint gets the `AshJsonApi.Resource` extension and a `json_api` type.
- The domain gets the `AshJsonApi.Domain` extension and a `base_route "/"` per resource. `GET` on a query becomes an `index` route, with `default_fields` from `picks`. `POST`, `PUT` or `PATCH` on an action of an entity, with `{id}` in the path, becomes a `patch` route; `POST` and `PUT` are served as `PATCH`, which a task notes.
- With pages, the domains are added to the `<App>Web.AshJsonApiRouter` that the AshJsonApi installer creates, which the Phoenix router forwards under `/api/json`, with Swagger UI at `/api/json/swaggerui`.
- Without pages, `lib/<app>/api_router.ex` defines `<App>.ApiRouter` with `use AshJsonApi.Router` over the domains and an OpenAPI document at `/open_api`, and the application starts `{Bandit, plug: <App>.ApiRouter, port: 4000}`.

Path parameters such as `{id}` become `:id`. Authentication, rate limits and CORS are tasks.

### Tests

Invariants, policies on entities, transitions and actions with preconditions get skipped ExUnit tests in the test module of their resource, `test/<app>/<module>/<resource>_test.exs`. Each test is tagged with a skip reason that names its registry entry, and writing the bodies is a task of that entry. See [test skeletons](registry.md#test-skeletons).

```elixir
@tag skip: "registry task: sales.OrderFlow.transition[draft->placed]"
test "transition draft -> placed moves from allowed states"
```

## What becomes a task

Whatever cannot be translated is listed in the [registry](registry.md):

- many to many relationships, and derived or default fields of value types
- calculations over lists, and derived fields or defaults that do not translate
- invariants, preconditions and guards over calculations, relationships or other resources, and guards when an action has several transitions
- effects that create rows or emit events, and actions with several target states
- actions with `consistency eventual`, and actions without an entity
- policies, roles, events, externals and use cases
- jobs on events, and jobs whose filter does not translate
- authentication, rate limits and CORS of interfaces, and endpoints that do not fit the route patterns
- flows, actors, tenants, and interfaces with a protocol other than `rest`

## Run the generated project

```sh
cd build/shop
mix ash.setup
iex -S mix
mix test
```

`mix ash.setup` creates the database and runs the migrations; it needs a PostgreSQL server that matches the repo configuration in `config/`. Without pages, starting the application starts Bandit, so the JSON:API answers on `http://localhost:4000`, for example `GET /orders`. With pages, run `mix phx.server` instead: the pages answer on `http://localhost:4000`, for example `/orders`, and the JSON:API under `/api/json`. `mix test` is also the command the registry stores, so the AI tools run it after each task.

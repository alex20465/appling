---
title: Django target
description: What @appling/codegen-django generates from a model, how the generated Django project is laid out, and how to run it.
---

`@appling/codegen-django` turns a model into a draft [Django](https://www.djangoproject.com) 6.1 project managed by [uv](https://docs.astral.sh/uv/). Every module becomes a Django app; domain elements become models, behavior becomes plain functions and signals, and REST interfaces become [Django REST framework](https://www.django-rest-framework.org) views.

## Requirements

| Tool | Notes |
|---|---|
| `uv` | Must be on the `PATH`. `appling generate` checks it with `uv --version` before it runs. |
| Python 3.12 or later | Required by Django 6. uv installs Python into the project, but this is not checked: if uv picks an older interpreter, `uv add django` fails. |
| Network | uv downloads Django and REST framework. |

## Configuration

```json
{
  "generate": [
    { "extension": "@appling/codegen-django", "out": "build/shop", "options": { "name": "shop" } }
  ]
}
```

| Option | Meaning |
|---|---|
| `name` | The Python project name passed to `uv init`. Default: the name of the output folder. |

The Django settings package is always `config`.

## Project setup

The extension creates the project with uv and Django's own commands, then patches the files they create:

| Step | Command |
|---|---|
| Python project | `uv init --bare --name <name>` |
| Dependencies | `uv add django~=6.1.0`, plus `djangorestframework~=3.16` when the model has projections or interfaces, and [`rules~=3.5`](https://github.com/dfunckt/django-rules) when it has roles or actors |
| Django project | `uv run django-admin startproject config .`, and `rest_framework` in `INSTALLED_APPS` when REST framework is installed |
| Apps | `uv run python manage.py startapp <app>` per module, added to `INSTALLED_APPS` |
| Migrations | `uv run python manage.py makemigrations`, as the very last step |

Because the project ends with `makemigrations`, its migration history starts with the generated models. [`appling generate --migrate`](migrations.md#django) continues that history later.

## Model to Django

The app of a module is its qualified name with dots replaced by underscores: the nested module `a.b` becomes the app `a_b`. Names of functions and signals are the snake case form of the element name, such as `place_order` for `PlaceOrder`.

| Model | Django |
|---|---|
| `module` | an app created by `startapp`, in `INSTALLED_APPS` |
| `enum` | a `models.TextChoices` class in `<app>/enums.py`; each value becomes an upper case member, such as `DRAFT = "draft"` |
| `value` | a `TypedDict` in `<app>/values.py` |
| `entity` | a `models.Model` in `<app>/models.py`; the entity that actors are bound to with `is` (exactly one) extends `AbstractUser` instead, and `AUTH_USER_MODEL` in `config/settings.py` points at it (see [actors](#actors)) |
| stored field | a model field (see the next table) |
| derived field | a `@property` that returns the expression translated to Python |
| `invariant` | a `CheckConstraint` in `Meta.constraints`, named `<app>_<entity>_<label>`, when the condition compares stored fields with constants or other stored fields; a test class |
| `policy` | functions in `<app>/policies.py` that actions, queries, use cases, serializers and pages call (see [access](#access)); a test class |
| `role` | a django-rules predicate `is_<role>(user)` in `<app>/roles.py` and a Django group (see [roles](#roles)) |
| `actor` | a Django group, a predicate `is_<actor>(user)` in `<app>/actors.py`, and its fields on the user model (see [actors](#actors)) |
| `tenant` | a context variable and a middleware in `<app>/tenants.py` (see [tenants](#tenants)) |
| `event` | a `Signal` in `<app>/events.py` |
| `errors` | exception classes in `<app>/errors.py`, which also defines `InvalidTransition` |
| `action` | a function in `<app>/actions.py` (see [actions](#actions)) |
| `machine` | transitions of actions become part of the action function; transitions on events become signal receivers in `<app>/handlers.py`, connected in `AppConfig.ready` |
| `transition` | a test class |
| scheduled `job` | a `django.tasks` task in `<app>/jobs.py` and a management command named after the job |
| `job` on an event | a signal receiver in `<app>/handlers.py` |
| `query` | a function in `<app>/queries.py` returning a queryset with filter and ordering, plus a `<QUERY>_PAGE_SIZE` constant for `paginate`; its inputs are parameters, required ones first and optional ones defaulting to `None`, and callers pass them by name. A query with inputs also gets `<Query>Input` in `<app>/serializers.py`, a REST framework serializer that parses the inputs from URL parameters (entities by primary key, enums by value, lists from repeated parameters) |
| `projection` | a REST framework `ModelSerializer` in `<app>/serializers.py`; derived fields and computed fields that follow references, such as `customer.name`, become read only fields |
| `external` | a `typing.Protocol` in `<app>/externals.py` |
| `setting`, `secret` of an external | a constant in `config/settings.py` read from the environment and a line in `.env.example` (see [settings and secrets](#settings-and-secrets)) |
| `interface webhook` | tasks: register each endpoint at the vendor, receive it and verify its signature |
| `usecase` | a function in `<app>/usecases.py` that calls its steps in order |
| `interface rest` | views in `<app>/api.py` and routes in `<app>/api_urls.py`, included under `api/` in `config/urls.py`, so `GET "/orders"` answers at `/api/orders` |
| `page` | a view in `<app>/pages.py` and a route in `<app>/urls.py`, included at the site root (see [pages](#pages)) |
| `navigation` | the menu of `<app>/templates/<app>/base.html` |
| `messages` | labels in `<app>/messages.py`, used for the columns and fields of pages |
| `flow` | not generated; a `todo` entry in the [registry](registry.md) |

### Fields

| Appling type | Django field |
|---|---|
| `String` | `CharField(max_length=255)` |
| `Text` | `TextField()` |
| `Int` | `IntegerField()` |
| `Decimal` | `DecimalField(max_digits=19, decimal_places=4)` |
| `Money` | `DecimalField(max_digits=19, decimal_places=2)` |
| `Bool` | `BooleanField()` |
| `Date` | `DateField()` |
| `DateTime` | `DateTimeField()` |
| `Duration` | `DurationField()` |
| `File` | `FileField(upload_to="<app>/<entity>/")` |
| `Uuid` | `UUIDField()` |
| an enum | `CharField(max_length=..., choices=<Enum>.choices)` |
| an entity | `ForeignKey("<app>.<Entity>", on_delete=...)`: `CASCADE` when the field is `owned`, otherwise `PROTECT` |
| a list of entities | `ManyToManyField("<app>.<Entity>")` |
| a value type or any other list | `JSONField(encoder=DjangoJSONEncoder)` with `default=dict` or `default=list` |

| Modifier | Django |
|---|---|
| `?` | `null=True, blank=True` |
| `unique` | `unique=True` |
| `default` | `default=`; `now` becomes `timezone.now` |

For the `Order` entity of the [example](../../examples/sales.appling), this gives:

```python
class Order(models.Model):
    reference = models.CharField(max_length=255, unique=True)
    customer = models.ForeignKey("crm.Account", on_delete=models.PROTECT)
    lines = models.JSONField(encoder=DjangoJSONEncoder, default=list)
    status = models.CharField(max_length=32, choices=OrderStatus.choices, default=OrderStatus.DRAFT)
    created_at = models.DateTimeField()
    placed_at = models.DateTimeField(null=True, blank=True)
    paid_at = models.DateTimeField(null=True, blank=True)

    @property
    def total(self):
        return sum([Decimal(l["amount"]) for l in self.lines])
```

### Actions

An action becomes a function that takes the entity instance first, its inputs as keyword arguments and an optional `actor`. It runs in one transaction (`@transaction.atomic`) unless the action has `consistency eventual`. In order, it:

1. Checks each precondition and raises the declared error, or `ValueError` without one.
2. Applies the transition of the state machine: the current state and the guard pick the branch, and any other state raises `InvalidTransition`.
3. Applies the effects: `set` assigns a field, `create` calls `objects.create` (`line = Line.objects.create(...)` with `as line`), `emit` sends the event's signal after the transaction commits, `for item in items` loops over `order.items.all()`, `update item.product { ... }` assigns the fields of `item.product` and saves it (inside `if ... is not None:` for an optional path), `delete item` calls `item.delete()`, and `delete self` deletes the instance last instead of saving it.
4. Saves the instance when it changed.

```python
@transaction.atomic
def place_order(order: Order, *, actor=None) -> None:
    if not (len(order.lines) > 0):
        raise EmptyOrder()
    if order.status in (OrderStatus.DRAFT,):
        transaction.on_commit(lambda: order_placed.send(sender=None, order=order))
        order.status = OrderStatus.PLACED
    else:
        raise InvalidTransition("place_order", order.status)
    order.placed_at = timezone.now()
    order.save()
```

A use case calls its actions with `actor=actor`. Each external system it calls becomes a keyword parameter typed with its protocol, such as `payments: Payments`, so you pass the client in. Error handlers become `try`/`except` blocks.

### REST layer

Each endpoint of a REST interface becomes a view:

| Endpoint | View |
|---|---|
| `GET` a query, with a projection | a `generics.ListAPIView` over the query function, using the projection's serializer; `picks` creates a serializer subclass with only those fields; `paginate` adds a `PageNumberPagination`. The query's inputs come from the path and the query string through `<Query>Input`; parameters that do not parse answer `400` |
| `POST`, `PUT`, `PATCH` or `DELETE` an action | an `APIView` that loads the instance by `{id}`, calls the action with the request data and `actor=request.user`, and answers `204`; declared errors and `InvalidTransition` answer `400` with `{"error": "<name>"}` |

Path parameters become Django converters: `{id}` becomes `<int:id>`, others `<str:name>`. A `limit` on the interface becomes a `UserRateThrottle` on every view. An action on an entity needs `{id}` in its path; endpoints that do not fit these patterns become tasks.

### Settings and secrets

Each `setting` and `secret` of an external becomes a constant in `config/settings.py`, named `<EXTERNAL>_<KEY>` in upper snake case and read from the environment variable of the same name (`import os` is added once):

| Type | Python |
|---|---|
| `Int` | `CLERK_MAX_SESSIONS = int(os.environ["CLERK_MAX_SESSIONS"]) if "CLERK_MAX_SESSIONS" in os.environ else None` |
| `Bool` | `CLERK_TEST_MODE = os.environ.get("CLERK_TEST_MODE", "").lower() in ("1", "true", "yes")` |
| any other | `CLERK_REGION = os.environ.get("CLERK_REGION")` |

A missing setting is `None` (`False` for a `Bool`). A `secret` is required: it is read through `required_env`, which `settings.py` defines once before the first secret, so the app stops at startup with `ImproperlyConfigured: Set the environment variable CLERK_SECRET_KEY (see .env.example)` when it is not set:

```python
CLERK_SECRET_KEY = required_env("CLERK_SECRET_KEY")
CLERK_INSTANCE = int(required_env("CLERK_INSTANCE"))   # a secret of type Int
```

Every management command loads the settings, so tests, `migrate` and `runserver` need the secrets too: fill `.env` from `.env.example` and load it into the environment. While generating, Appling runs its own `makemigrations` with a placeholder for each secret.

`.env.example` lists every key with an empty value, under a comment with its kind, its external and its `does` text:

```sh
# secret of Clerk: API keys page of the Clerk dashboard
CLERK_SECRET_KEY=
```

The setup on the vendor's side becomes [registry](registry.md) tasks: for every endpoint of an `interface webhook ... from <External>` one to register it at the vendor and one to receive it and verify its signature, and for `auth <scheme> from <External>` one to let the vendor issue the tokens, naming the model's roles for the role claim.

### Jobs

A scheduled job becomes a task of the [`django.tasks`](https://docs.djangoproject.com/en/6.1/topics/tasks/) framework that runs the action for every row matching the filter, plus a management command that enqueues it:

```python
@task
def expire_drafts() -> None:
    for order in Order.objects.filter((models.Q(status="draft")) & (models.Q(created_at__lt=timezone.now() - timedelta(hours=720)))):
        cancel(order)
```

Calling it on the cron schedule is a registry task, for example `schedule "python manage.py expire_drafts" with cron "0 3 * * *"`. Without a `TASKS` setting, Django uses its immediate backend and runs the task inline when the command enqueues it.

A job needs an action on an entity without required inputs; otherwise it becomes a task. A job on an event becomes a signal receiver when the event has a field of the entity's type.

### Tests

Invariants, policies, transitions and actions with preconditions get a `TestCase` class in `<app>/tests.py`, with one method per case. A case the model says everything about gets a body and runs; every other case is skipped, its skip reason names the registry entry, and writing the missing bodies is a task of that entry (the task lists the methods when only some are skipped). See [test skeletons](registry.md#test-skeletons).

| Rule | Test methods | Body |
|---|---|---|
| invariant | `test_holds_for_valid_rows`, `test_rejects_violations` | for an invariant enforced as a `CheckConstraint`: stores the factory's row; then sets one field the condition compares to a value (`-1`, `0` or `1000000` for numbers, either boolean, each enum literal) that breaks this invariant and no other, and asserts `IntegrityError` |
| policy | `test_allows_permitted_actors`, `test_denies_other_actors` | for a policy on a whole entity whose condition reads the actor only through `actor.is(...)` (of actors or of roles without a condition): signs in a user who is only in the group of one declared actor, takes the factory's row and asserts `can_<operation>_<entity>` for each operation the policy covers; true for an actor the policy and every other policy of that operation let through, false for an actor the policy keeps out. A policy on an action calls the action with `actor=user`: it runs through for an actor that `can_update_<entity>` and every policy of the action let through, and raises `PermissionDenied` for an actor the policy keeps out. A policy on a query calls the query with `actor=user`: the factory's row is in the result for an actor that the entity's read policies and every policy of the query let through, and not in it for an actor the policy keeps out. Every policy checked on the way must read the actor only through `actor.is(...)`. Use case and field policies, and conditions that read actor fields or the tenant, stay skipped |
| transition | `test_moves_from_allowed_states`, `test_refuses_other_states` | creates the entity in each allowed state, runs the action (or sends the event) and asserts the target state; in every state no transition of that action or event leaves, asserts `InvalidTransition` |
| action with preconditions | `test_precondition_<n>_is_enforced` | creates a row for which the precondition fails and asserts its error (`ValueError` without one) |

Test bodies create rows through factories in `<app>/factories.py`, one `make_<entity>(**fields)` per entity: every required stored field without a default gets a sample value (`"<field>-<n>"` for strings, `1` for numbers, `False`, the current date or time, one hour, a new UUID, the first enum literal), and a required reference gets a row from the referenced entity's factory. An entity with a required file, a value type or a cycle of required references has no factory.

A case only gets a body when the Appling simulator proves, on the factory's row, that the invariants hold (for an invariant test, also that the changed row breaks it; a field read only by `has()` may stay null, any other field the condition compares must not be null, because a database check passes on null), that the preconditions and the guard hold (or, for a precondition test, that the earlier preconditions hold and this one fails), and that the effects do not create, update or delete other rows or depend on the actor. Otherwise it stays skipped. In the examples, `PlaceOrder` requires order lines that the factory does not add, so its precondition test runs, while the tests of `draft -> placed` stay tasks. Event transitions are tested only when no job or other machine also handles the event. The actions run without an actor, which skips their policy checks, except in the tests of action policies. The allowed case of an action policy also needs an action that only sets fields: one that moves a state, creates, updates or deletes rows or emits an event keeps that case skipped. The allowed case of a query policy needs the query's filter to hold for the factory's row.

### Pages

A page is rendered on the server. Its view collects the page's components for the shared template `<app>/templates/<app>/page.html`, which extends the app's `base.html`:

| Component | Renders |
|---|---|
| `list <query> as <projection> { picks }` | a table of the query's rows with the picked projection fields, paginated by the query's `paginate`, and a button per row for each action; the query's inputs come from the page's query string, and parameters that do not parse answer `400` |
| `detail <projection>` | the record with the route's `{id}`, its fields, and a button for each action |
| `form <action>` | a field for each input of the action and a submit button |

Buttons and forms post to `/_actions/<app>/<action>/<id>/`, a runner view that calls the action as the signed in user, shows `<Action> done.` or `<Action> failed: <error>` through Django's messages, and returns to the page. Projection fields that follow references, such as `customer_name = customer.name`, are shown by following the path. Column and field labels come from the module's `messages` (`OrderSummary.total = "Total"`), in the active language, and default to the field name. A navigation item becomes a link in the menu of `base.html`.

## Project layout

For a model with the modules `crm` and `sales`:

```text
build/shop/
  pyproject.toml, uv.lock, manage.py
  config/
    settings.py          INSTALLED_APPS with rest_framework and every app
    urls.py              includes the page and API urls of the apps
  sales/
    models.py            entities
    enums.py             enums
    values.py            value types
    errors.py            InvalidTransition and declared errors
    roles.py, actors.py  role and actor predicates
    groups.py            creates the groups of roles and actors after migrate
    policies.py          entity policies
    tenants.py           the current tenant and its middleware
    events.py            signals
    actions.py           actions
    handlers.py          receivers for event transitions and event jobs
    apps.py              ready() connects handlers.py
    jobs.py              scheduled jobs
    management/commands/<job>.py
    queries.py           queries
    serializers.py       projections
    externals.py         protocols for external systems
    usecases.py          use cases
    api.py, api_urls.py  REST interface
    pages.py, urls.py    pages and the action runners they post to
    messages.py          labels per language
    templates/sales/     base.html with the navigation, page.html
    tests.py             tests of the rules, skipped where the model does not say enough
    factories.py         a make_<entity>() per entity the tests create
    migrations/
  crm/
    ...
  .appling/
    tasks.json           the task registry
```

An app only gets the files its module needs.

## Roles

A role becomes one predicate, and `actor.is(Role)` calls it wherever an expression is translated, such as in a precondition: `is_operator(actor)`. A user carries the role when they are in the Django group of the role or in the group of an actor that carries it. The condition of the role reads the actor's fields as fields of the user model:

```appling
module ops {
  entity User {
    disabled: Bool default false
    active: Bool = !disabled
  }
  role Operator { actor.active }
  actor human Employee is User roles Operator
}
```

```python
# ops/roles.py
import rules


@rules.predicate
def is_operator(user):
    return user is not None and user.groups.filter(name__in=["Operator", "Employee"]).exists() and user.active
```

`User` extends `AbstractUser` and keeps the derived `active` as a property. The predicates are plain functions, so they also combine with django-rules (`is_operator | is_admin`); `rules.add_perm` is not generated.

The groups of a module's roles and actors are listed in `<app>/groups.py`, whose `post_migrate` receiver creates them with `get_or_create`, so `migrate` sets them up. Assigning users to groups stays with you, for example in the admin.

## Actors

An actor becomes a Django group and a predicate in `<app>/actors.py`, which `actor.is(Employee)` calls:

```python
@rules.predicate
def is_employee(user):
    return user is not None and user.groups.filter(name="Employee").exists()
```

The current actor is the Django user. Fields declared on actors become fields of the user model, all optional (`null=True, blank=True`), since not every actor declares them; `actor.account` reads `user.account`. The user model is the entity the actors are bound to with `is` when there is exactly one. When no actor is bound and some declare fields, the module of the first such actor gets a `User(AbstractUser)` model (`ActorUser` when the module already has a `User`) and `AUTH_USER_MODEL` points at it. With actors bound to several entities, actor fields are tasks.

## Tenants

A tenant becomes `<app>/tenants.py`. `tenant` in an expression translates to `current_<tenant>()`, which reads a context variable; a middleware, appended to `MIDDLEWARE`, sets it for each request from the user model's field of the tenant's entity type, or to the user when the user model is that entity:

```python
class CompanyMiddleware:
    """Sets the current tenant for each request: the account of the signed in user."""

    def __call__(self, request):
        token = _company.set(getattr(request.user, "account", None))
        ...
```

Outside a request, such as in a job, the tenant is `None`. Without such a field, setting the tenant is a task. Rows are not filtered by tenant automatically; policies such as `account == tenant` do that.

## Access

Once the model has a policy, the generated code enforces every policy along the reference path, as [narrowing](../language/access.md#narrowing) describes, and nothing is open by default. A model without any policy generates no checks.

Each entity gets functions in `<app>/policies.py`:

| Function | True when |
|---|---|
| `can_<operation>_<entity>(actor, record)` | the actor is signed in and every whole record policy that covers the operation holds; `False` when none covers it |
| `can_read_<entity>_<field>(actor, record)` | the entity can be read and every read policy with `fields` that names the field holds |
| `readable_<entity>_rows(actor, rows)` | returns the queryset narrowed to the rows `can_read_<entity>` allows, as a `models.Q` when the read policies translate to lookups (`account == actor.account` becomes `models.Q(account=actor.account)`, `actor.is(Clerk)` a Q that matches every row or none), otherwise by testing each row |

```python
def can_update_order(actor, order) -> bool:
    if not getattr(actor, "is_authenticated", False):
        return False
    return is_clerk(actor) or ((is_customer(actor) and (order.customer == actor.account)) and (order.status == OrderStatus.DRAFT))
```

They are called where the model uses the element:

| Element | Check |
|---|---|
| action | first, `can_update_<entity>` of its entity and its own policies; a `create` effect builds the record, checks `can_create_<entity>` and then saves it; `update` and `delete` effects check `can_update_<entity>` or `can_delete_<entity>` of the record they change first; a failed check raises `PermissionDenied` |
| query | the query function takes `actor=None`, narrows the rows with `readable_<entity>_rows` and filters by its own policies |
| use case | its own policies first; the steps check theirs |
| projection | the serializer sets a field the actor may not read to `None` in `to_representation` |
| page | a detail raises `PermissionDenied` when the record cannot be read; lists pass the user to the query; guarded fields show `None` |

```python
@transaction.atomic
def cancel(order: Order, *, reason: str | None = None, actor=None) -> None:
    if actor is not None and not (actor.is_authenticated and can_update_order(actor, order) and is_clerk(actor)):
        raise PermissionDenied("Cancel")
```

Views pass `request.user`, and REST framework and Django answer `PermissionDenied` with `403`. Code that calls with `actor=None`, such as jobs and event receivers, runs as the system and is not checked. Policy conditions without a Python translation deny (`return False`) and stay tasks; field policies that also cover writes are enforced on reads only, the rest is a task. Delete policies become `can_delete_<entity>`, which no generated code calls, since nothing in the model deletes; Django's `has_perm` and the admin do not use the functions.

## Descriptions

A [`does`](../language/descriptions.md) text goes into the generated code as documentation:

| Element | Becomes |
|---|---|
| Entity, enum, value type, error | The class docstring |
| Action, query, use case, role | The function docstring (for a role, of its predicate) |
| Projection, external | The serializer or `Protocol` class docstring |
| External operation | The docstring of its `Protocol` method |
| Entity field | `help_text` of the model field |

Each text is also a [registry task](registry.md#status).

## What becomes a task

Whatever cannot be translated is listed in the [registry](registry.md):

- invariants over derived fields, lists or other entities, and derived fields or defaults that use `actor` or other context
- policy and role conditions without a Python translation, and field policies on writes
- preconditions, guards and effects without a Python translation
- actions without any generated code, and actions with `consistency eventual`
- the client of an external system
- the cron schedule of jobs, and jobs that do not fit the patterns above
- use cases from their first `await` on, or from the first call that cannot be translated
- authentication and CORS of interfaces, and endpoints that do not fit the view patterns
- computed projection fields that are not a path over entity fields
- row actions that need inputs, details and forms on pages without `{id}` in the route, navigation items to such pages, and flows
- the tenant of a request when the user model has no field of the tenant's entity, actor fields when actors are bound to several entities, and interfaces with a protocol other than `rest`

## Run the generated project

```sh
cd build/shop
uv run python manage.py migrate
uv run python manage.py runserver
uv run python manage.py test
```

`migrate` creates the database (SQLite, as configured by `startproject`). `test` is also the command the registry stores, so the AI tools run it after each task. A scheduled job runs with its management command, for example `uv run python manage.py expire_drafts`.

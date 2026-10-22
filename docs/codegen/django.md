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
| Dependencies | `uv add django~=6.1.0`, plus `djangorestframework~=3.16` when the model has projections or interfaces |
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
| `entity` | a `models.Model` in `<app>/models.py` |
| stored field | a model field (see the next table) |
| derived field | a `@property` that returns the expression translated to Python |
| `invariant` | a `CheckConstraint` in `Meta.constraints`, named `<app>_<entity>_<label>`, when the condition compares stored fields with constants or other stored fields; a test class |
| `policy` | a test class; enforcing it is a task |
| `role` | a task to create a Django group for the role |
| `event` | a `Signal` in `<app>/events.py` |
| `errors` | exception classes in `<app>/errors.py`, which also defines `InvalidTransition` |
| `action` | a function in `<app>/actions.py` (see [actions](#actions)) |
| `machine` | transitions of actions become part of the action function; transitions on events become signal receivers in `<app>/handlers.py`, connected in `AppConfig.ready` |
| `transition` | a test class |
| scheduled `job` | a `django.tasks` task in `<app>/jobs.py` and a management command named after the job |
| `job` on an event | a signal receiver in `<app>/handlers.py` |
| `query` | a function in `<app>/queries.py` returning a queryset with filter and ordering, plus a `<QUERY>_PAGE_SIZE` constant for `paginate` |
| `projection` | a REST framework `ModelSerializer` in `<app>/serializers.py`; derived fields and computed fields that follow references, such as `customer.name`, become read only fields |
| `external` | a `typing.Protocol` in `<app>/externals.py` |
| `usecase` | a function in `<app>/usecases.py` that calls its steps in order |
| `interface rest` | views in `<app>/api.py` and routes in `<app>/api_urls.py`, included under `api/` in `config/urls.py`, so `GET "/orders"` answers at `/api/orders` |
| `page` | a view in `<app>/pages.py` and a route in `<app>/urls.py`, included at the site root (see [pages](#pages)) |
| `navigation` | the menu of `<app>/templates/<app>/base.html` |
| `messages` | labels in `<app>/messages.py`, used for the columns and fields of pages |
| `flow`, actors, tenants | not generated; `todo` entries in the [registry](registry.md) |

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
3. Applies the effects: `set` assigns a field, `create` calls `objects.create`, `emit` sends the event's signal after the transaction commits.
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
| `GET` a query, with a projection | a `generics.ListAPIView` over the query function, using the projection's serializer; `picks` creates a serializer subclass with only those fields; `paginate` adds a `PageNumberPagination` |
| `POST`, `PUT`, `PATCH` or `DELETE` an action | an `APIView` that loads the instance by `{id}`, calls the action with the request data and `actor=request.user`, and answers `204`; declared errors and `InvalidTransition` answer `400` with `{"error": "<name>"}` |

Path parameters become Django converters: `{id}` becomes `<int:id>`, others `<str:name>`. A `limit` on the interface becomes a `UserRateThrottle` on every view. An action on an entity needs `{id}` in its path; endpoints that do not fit these patterns become tasks.

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

Invariants, policies, transitions and actions with preconditions get a `TestCase` class in `<app>/tests.py`, with one skipped method per case. The skip reason names the registry entry, and writing the bodies is a task of that entry. See [test skeletons](registry.md#test-skeletons).

| Rule | Test methods |
|---|---|
| invariant | `test_holds_for_valid_rows`, `test_rejects_violations` |
| policy | `test_allows_permitted_actors`, `test_denies_other_actors` |
| transition | `test_moves_from_allowed_states`, `test_refuses_other_states` |
| action with preconditions | `test_precondition_<n>_is_enforced` |

### Pages

A page is rendered on the server. Its view collects the page's components for the shared template `<app>/templates/<app>/page.html`, which extends the app's `base.html`:

| Component | Renders |
|---|---|
| `list <query> as <projection> { picks }` | a table of the query's rows with the picked projection fields, paginated by the query's `paginate`, and a button per row for each action |
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
    tests.py             skipped test skeletons
    migrations/
  crm/
    ...
  .appling/
    tasks.json           the task registry
```

An app only gets the files its module needs.

## What becomes a task

Whatever cannot be translated is listed in the [registry](registry.md):

- invariants over derived fields, lists or other entities, and derived fields or defaults that use `actor` or other context
- policies and roles
- preconditions, guards and effects without a Python translation
- actions without any generated code, and actions with `consistency eventual`
- the client of an external system
- the cron schedule of jobs, and jobs that do not fit the patterns above
- use cases from their first `await` on, or from the first call that cannot be translated
- authentication and CORS of interfaces, and endpoints that do not fit the view patterns
- computed projection fields that are not a path over entity fields
- row actions that need inputs, details and forms on pages without `{id}` in the route, navigation items to such pages, and flows
- actors, tenants, and interfaces with a protocol other than `rest`

## Run the generated project

```sh
cd build/shop
uv run python manage.py migrate
uv run python manage.py runserver
uv run python manage.py test
```

`migrate` creates the database (SQLite, as configured by `startproject`). `test` is also the command the registry stores, so the AI tools run it after each task. A scheduled job runs with its management command, for example `uv run python manage.py expire_drafts`.

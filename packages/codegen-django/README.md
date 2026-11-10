# @appling/codegen-django

Appling code generation extension for [Django](https://www.djangoproject.com). It turns an Appling model into a draft Django project managed by [uv](https://docs.astral.sh/uv/).

```json
{
  "generate": [
    { "extension": "@appling/codegen-django", "out": "build/shop", "options": { "name": "shop" } }
  ]
}
```

Requires `uv` on the PATH. Python and Django (6.1) are installed by uv into the project.

## What it generates

| Model | Django |
|---|---|
| project | `uv init`, `uv add django`, `django-admin startproject config .` |
| `module` | `manage.py startapp`, added to `INSTALLED_APPS`; nested modules `a.b` become the app `a_b` |
| `enum` | `models.TextChoices` in `<app>/enums.py` |
| `value` | `TypedDict` in `<app>/values.py`; fields of a value type are stored as `JSONField` |
| `entity` | a model in `<app>/models.py` |
| field types | `CharField`, `TextField`, `IntegerField`, `DecimalField`, `BooleanField`, `DateField`, `DateTimeField`, `DurationField`, `FileField`, `UUIDField`; enums as choices; entities as `ForeignKey` (`CASCADE` when `owned`, else `PROTECT`) or `ManyToManyField`; lists as `JSONField` |
| `unique`, `?`, `default` | `unique=True`, `null=True, blank=True`, `default=` |
| derived field | a `@property` with the expression translated to Python |
| `invariant` | `CheckConstraint` in `Meta.constraints` when it compares stored fields with constants or other fields |
| `action` | a function in `<app>/actions.py`, atomic unless `consistency eventual`: preconditions raise the declared errors, transitions of the state machine check the current state and guard, effects set fields, create rows (`as name` keeps them in a variable), send events after commit, loop over collection relationships, update and save related records and delete records |
| `errors` | exception classes in `<app>/errors.py`, with `InvalidTransition` for state machines |
| `event` | a Django `Signal` in `<app>/events.py` |
| `machine` | transitions triggered by an event become signal receivers in `<app>/handlers.py`, connected in `AppConfig.ready` |
| `job` | scheduled: a `django.tasks` task in `<app>/jobs.py` plus a management command for the scheduler; on an event: a signal receiver |
| `query` | a function in `<app>/queries.py` returning a queryset with filter and ordering, and the page size; its inputs are parameters, and a `<Query>Input` serializer reads them from URL parameters for endpoints and pages |
| `projection` | a REST framework `ModelSerializer` in `<app>/serializers.py`; computed fields that follow references become `source` paths |
| `external` | a `typing.Protocol` in `<app>/externals.py` that use cases receive as a parameter |
| `setting`, `secret` | `<EXTERNAL>_<KEY>` in `config/settings.py`, read from the environment (a missing `secret` stops the app with `ImproperlyConfigured`), and a line in `.env.example` |
| `usecase` | a function in `<app>/usecases.py` calling its steps in order, with `try`/`except` for error handlers |
| `interface rest` | REST framework views in `<app>/api.py` and routes in `<app>/api_urls.py` under `api/`: list views for queries with projection, picks and pagination, `APIView`s for actions; `limit` becomes a throttle |
| `page` | a server rendered view with its list, detail and form components, posting row actions and forms to a runner view per action |
| `navigation`, `messages` | the menu of the base template, and labels per language |
| `role` | a [django-rules](https://github.com/dfunckt/django-rules) predicate `is_<role>(user)` in `<app>/roles.py` (membership in the group of the role or of an actor that carries it, and the role's condition), called wherever `actor.is(Role)` is translated |
| `actor` | a Django group and a predicate `is_<actor>(user)` in `<app>/actors.py`; the entity actors are bound to with `is` extends `AbstractUser` and becomes `AUTH_USER_MODEL`, and actor fields become optional fields of that user model (without a bound entity, of a generated `User(AbstractUser)`) |
| `tenant` | `<app>/tenants.py` with `current_<tenant>()` (what `tenant` translates to) and a middleware in `MIDDLEWARE` that sets it per request from the user's field of the tenant's entity |
| `policy` | entity policies become `can_<operation>_<entity>(actor, record)`, `can_read_<entity>_<field>` and `readable_<entity>_rows(actor, rows)` in `<app>/policies.py`; actions, queries and use cases check them and their own policies and raise `PermissionDenied`, serializers and pages hide fields the actor may not read. Calls with `actor=None` (jobs, receivers) are not checked; a model without policies generates no checks |
| groups | the groups of roles and actors are created after `migrate` by a `post_migrate` receiver in `<app>/groups.py` |

| `does` | the docstring of the generated class or function, `help_text` on model fields, and a registry task |
| rules | a `TestCase` per invariant, policy, transition and action with preconditions in `<app>/tests.py`, one method per case; tests of invariants enforced as check constraints, of entity, action and query policies (and the denied case of use case policies) that read the actor only through `actor.is(...)`, of transitions and of preconditions get bodies (rows from `make_<entity>()` factories in `<app>/factories.py`) where the simulator proves the fixture satisfies the guards, preconditions and invariants; the other cases are skipped and writing them is a registry task |
| `scenario` | a `TestCase` in `<app>/tests.py` that creates the given rows, signs in the actor, calls the action or use case and asserts the `then`: the checks on the reloaded rows, the emitted events, the declared error or `PermissionDenied`. It replaces the precondition and transition tests of what it runs; a scenario the generated code cannot reproduce stays a skipped test and a registry task |

Models with projections or interfaces also get Django REST framework. The project ends with `manage.py makemigrations`, so its migration history starts with the generated models.

`appling generate --migrate` continues that history: renamed, retyped and removed fields become `RenameField`, `AlterField` and `RemoveField`, renamed and removed entities `RenameModel` and `DeleteModel`, a renamed enum value an `AlterField` with a data migration of the stored values. `models.py` and `enums.py` change with them, so `makemigrations` finds nothing left to guess.

What cannot be translated becomes a registry task: invariants over derived fields or other entities, derived fields and defaults that use `actor` or other context, policy and role conditions without a Python translation, field policies on writes, guards and effects that cannot be expressed in Python, the client of an external system, scheduling of jobs, use cases from their first `await` on, authentication and CORS of interfaces, webhook endpoints and the vendor side setup (registering webhooks, issuing tokens with a role claim).

## License

MIT

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
| `action` | a function in `<app>/actions.py`, atomic unless `consistency eventual`: preconditions raise the declared errors, transitions of the state machine check the current state and guard, effects set fields, create rows and send events after commit |
| `errors` | exception classes in `<app>/errors.py`, with `InvalidTransition` for state machines |
| `event` | a Django `Signal` in `<app>/events.py` |
| `machine` | transitions triggered by an event become signal receivers in `<app>/handlers.py`, connected in `AppConfig.ready` |
| `job` | scheduled: a `django.tasks` task in `<app>/jobs.py` plus a management command for the scheduler; on an event: a signal receiver |
| `query` | a function in `<app>/queries.py` returning a queryset with filter and ordering, and the page size |
| `projection` | a REST framework `ModelSerializer` in `<app>/serializers.py`; computed fields that follow references become `source` paths |
| `external` | a `typing.Protocol` in `<app>/externals.py` that use cases receive as a parameter |
| `usecase` | a function in `<app>/usecases.py` calling its steps in order, with `try`/`except` for error handlers |
| `interface rest` | REST framework views in `<app>/api.py` and routes in `<app>/urls.py`: list views for queries with projection, picks and pagination, `APIView`s for actions; `limit` becomes a throttle |

| rules | a `TestCase` per invariant, policy, transition and action with preconditions in `<app>/tests.py`, one skipped method per case; writing their bodies is a registry task |

Models with projections or interfaces also get Django REST framework. The project ends with `manage.py makemigrations`, so its migration history starts with the generated models.

`appling generate --migrate` continues that history: renamed, retyped and removed fields become `RenameField`, `AlterField` and `RemoveField`, renamed and removed entities `RenameModel` and `DeleteModel`, a renamed enum value an `AlterField` with a data migration of the stored values. `models.py` and `enums.py` change with them, so `makemigrations` finds nothing left to guess.

What cannot be translated becomes a registry task: invariants over derived fields or other entities, derived fields and defaults that use `actor` or other context, policies, roles, guards and effects that cannot be expressed in Python, the client of an external system, scheduling of jobs, use cases from their first `await` on, authentication and CORS of interfaces.

## License

MIT

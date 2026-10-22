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

What cannot be translated becomes a registry task: invariants over derived fields or other entities, derived fields and defaults that use `actor` or other context, and entity policies.

## License

MIT

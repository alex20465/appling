---
title: Templates
description: Read and change the Nunjucks templates the code generators write their code with, per project and per template.
---

Every built in extension writes its code through [Nunjucks](https://mozilla.github.io/nunjucks/templating.html) templates: one readable template per element kind, such as an entity, an enum, an action or a test case. The extension computes what a template cannot say well, such as translated expressions, imports and patches of framework files, and hands each template that data. Registry tasks and the skipped test skeletons for open work stay the same, whatever template you use.

## Where the templates are

Each extension ships its templates in the `templates/` folder of its package, one folder per area of the generated project:

```sh
$ ls node_modules/@appling/codegen-django/templates
access  api  application  behavior  migrations  models  pages  python  tests  urls  vendors
$ ls node_modules/@appling/codegen-django/templates/models
actor-user.py.njk  entity.py.njk  enum.py.njk  value.py.njk
```

Every template starts with a comment that says what it renders and which file the code lands in. Shared pieces, such as the docstring of a Python class, are macros in a folder named after the language (`python/`, `elixir/`, `go/`, `rust/`).

## Override a template

Put a file at the same path in the project's override folder, `.appling/templates/<target>/`, next to `appling.config.json`. `<target>` is the extension's name without its scope and `codegen-` prefix: `django`, `ash`, `go` or `rust`. A template you leave out comes from the extension.

To give every Django enum choice a readable label, copy the enum template and change the line of a literal:

```sh
mkdir -p .appling/templates/django/models
cp node_modules/@appling/codegen-django/templates/models/enum.py.njk .appling/templates/django/models/
```

```jinja
{% import "python/macros.njk" as py %}
class {{ name }}(models.TextChoices):
{{ py.docstring(doc) -}}
{% for literal in literals %}
    {{ literal.constant }} = {{ literal.value | dump }}, {{ literal.value | capitalize | dump }}
{% endfor %}
```

`appling generate` then writes `OPEN = "open", "Open"` for every literal of every enum, and the rest as before.

To keep the overrides somewhere else, set the target option `templates` to a folder relative to `appling.config.json`:

```json
{
  "generate": [
    { "extension": "@appling/codegen-django", "out": "build/shop", "options": { "templates": "templates/django" } }
  ]
}
```

## Change one block

A template with several sections names each one as a block. An override can extend the extension's own template through the `original:` prefix and replace only the blocks it changes. This override of the Django entity template keeps the fields and adds an ordering to every model:

```jinja
{% extends "original:models/entity.py.njk" %}
{% block meta %}

    class Meta:
        ordering = ["pk"]
{% endblock %}
```

A block of an override sees the template's data and the macros the original imports.

## What a template gets

The data of a template is what its `{{ }}` names: plain values, lists, and code strings the extension already translated, such as a field declaration or a condition. Read the extension's template to see the names. A name the data does not have stops the generation with an error that names the template, so a typo does not write broken code silently.

The templates render with these settings:

| Setting | Effect |
|---|---|
| `autoescape: false` | Code is written as is, without HTML escaping |
| `trimBlocks`, `lstripBlocks` | A line holding only a tag such as `{% for %}` or `{% endif %}` leaves no blank line |
| `throwOnUndefined` | An unknown name is an error |

The output loses the blank lines before and after it, so a template may start with a comment. On a line that only calls a macro, end the call with `-}}`, so an empty result leaves no blank line.

> [!NOTE]
> [Sync](sync.md) merges a new generation with the project, so a changed template reaches an existing project like a changed model does: through `appling generate --sync`.

## In your own extension

An extension sets `templates` to the folder of its templates and renders them with `context.render(path, data)`; see [writing an extension](extensions.md#templates).

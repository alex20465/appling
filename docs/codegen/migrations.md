---
title: Migrating a generated project
description: How appling generate --migrate carries the rename, retype and remove steps of the model into a project that was already generated, keeping the data.
---

Generation runs once. When the model changes afterwards, `appling generate --migrate` carries its [migration steps](../language/migrations.md) into the generated project: renames, type changes and removals become framework migrations that keep the data, the generated model code changes with them, and updating the rest of the code becomes registry tasks.

```sh
appling generate --migrate [files or folders...]
```

## Migration steps in the model

Migration steps live in `migration` blocks of the module they change. Each step names the element as it was before the step:

```appling check
module shop {
  entity Item {
    number: String
    price: Money
  }

  migration since_v1_0_0 {
    rename Item.code -> number
    retype Item.price: Decimal -> Money
    remove Item.legacy
  }
}
```

You rarely write them by hand. Once a release exists (`appling release <version>`), the IDE and the AI tools record renames, type changes and removals of released domain elements as steps in a block named after the release, such as `since_v1_0_0`. See [migrations](../language/migrations.md) for the language side.

## Which steps are pending

The generated project keeps the steps it has applied in `.appling/migrations.json`, as a list of ids. An id is the qualified name of the migration block and the position of the step in it:

```json
[
  "shop.since_v1_0_0#0",
  "shop.since_v1_0_0#1",
  "shop.since_v1_0_0#2"
]
```

`--migrate` collects every step of the model whose id is not in that list, module by module in declaration order. For each pending step it works out:

| Field | Meaning |
|---|---|
| `target` | The qualified name of the element before the step, such as `shop.Item.code` |
| `current` | Where the element lives now, after this step and every later step of the same module, such as `shop.Item.number`. Empty when the element was removed. |
| `parent` | The qualified name of the target's parent now, such as `shop.Item` |
| `newName`, `oldType`, `newType` | The details of the step |

Following the later steps matters: when `Item.code` was renamed to `ref` and later to `sku`, the first step already knows that the field is called `sku` in today's model.

The extension turns each change into steps. Command steps that are identical are run once. Tasks go to the registry entry of the changed element (its current name, or its old name when it was removed), which turns `partial`; a task for an element without an entry is dropped. After a successful run, the ids of the applied steps are appended to `.appling/migrations.json`, so a second run finds nothing to do:

```text
$ appling generate --migrate
shop.Item.number: template: shop/migrations/0002_appling_since_v1_0_0.py
shop.Item.number: template: shop/models.py
shop.Item.price: template: shop/migrations/0002_appling_since_v1_0_0.py
shop.Item.price: template: shop/models.py
shop.Item.legacy: template: shop/migrations/0002_appling_since_v1_0_0.py
shop.Item.legacy: template: shop/models.py
build/shop: 3 migration step(s) applied, 3 task(s) added to the registry
$ appling generate --migrate
build/shop: no pending migration steps
```

`--migrate` needs a project that `appling generate` created: it stops with `<out> was not generated yet` when the output folder has no registry. It does not check prerequisites, so the framework tools must be installed when a step runs a command.

> [!WARNING]
> `appling generate` does not record the steps that already exist in the model as applied. If the model had migration blocks when you generated the project, the first `--migrate` treats all of them as pending, although the generated code already reflects them. Write the ids of those steps into `.appling/migrations.json` of the new project before you run `--migrate`.

## Why renames are explicit

A rename in the code looks like one field removed and another added. A framework that compares the models with the database, such as Django's `makemigrations` or AshPostgres's migration generator, has to guess whether that was a rename, and a wrong guess drops the column with its data.

The model already knows: the rename step says so. The generator writes the rename operation itself and changes the model code in the same run, so the framework's own migration tools find nothing left to guess.

## Django

Every run writes new migration files, so a migration that was already applied never changes. Per app and block, the operations go into `<app>/migrations/<n>_appling_<block>.py`, numbered after and depending on the app's latest migration.

| Model step | Django migration | Code change |
|---|---|---|
| rename a field of an entity | `RenameField` | the field in `<app>/models.py` |
| retype a field of an entity | `AlterField` with the new field | the field in `<app>/models.py` |
| remove a field of an entity | `RemoveField` | the field line removed from `<app>/models.py` |
| rename an entity | `RenameModel` | the class in `<app>/models.py` |
| remove an entity | `DeleteModel` | the class removed from `<app>/models.py` |
| rename an enum value | `AlterField` for every entity field of that enum, and a separate data migration `<n>_appling_<block>_data.py` that runs after it and updates the stored values with a module level function | the member in `<app>/enums.py` and every use of it in the Python files of the apps |

For the example above, the generated migration is:

```python
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("shop", "0001_initial")]

    operations = [
        migrations.RenameField(model_name="item", old_name="code", new_name="number"),
        migrations.AlterField(model_name="item", name="price", field=models.DecimalField(max_digits=19, decimal_places=2)),
        migrations.RemoveField(model_name="item", name="legacy"),
    ]
```

Every `--migrate` run writes new migration files after the app's latest one, so a migration that is already applied never changes. Enum choices are written out as values in migrations, as Django does itself, so the history does not change when the enum changes later. Each mapped step also adds the task `update the code that uses <target> after the <kind>; models and migrations are done`. Any other step, such as a change to a value type, becomes the task `carry the <kind> of <target> into the database and the code`.

Apply the migration with `uv run python manage.py migrate`.

## Ash

The Ash extension handles the fields of entities. For each step it patches the resource, appends a statement to an Ecto migration `priv/repo/migrations/<stamp>_appling_<block>.exs` (one timestamp per run), and then runs `mix ash_postgres.generate_migrations --snapshots-only` once, so the resource snapshots match and a later `mix ash.codegen` does not see the rename as a drop and an add.

| Model step | Ecto migration | Resource change |
|---|---|---|
| rename a field | `rename table(:<table>), :old, to: :new` | every `:old` in the resource file becomes `:new` |
| retype a field | `modify :field, <column type>` in `alter table` | the attribute's type |
| remove a field | `remove :field` in `alter table` | the attribute and every mention of `:field` removed |

The table name comes from the `table "..."` line of the resource; without one, the step becomes a task. Each mapped step adds the task `update the code that uses <target> after the <kind>; resources and migrations are done`. Renamed or removed entities, renamed enum values and anything else become the task `carry the <kind> of <target> into the resources and the database`.

Apply the migration with `mix ash.migrate`.

## What stays open

Migrations and model code are done after `--migrate`; the code that uses the changed element is not. Every change adds a task to the registry entry of the element, so the next pass through the [registry](registry.md) updates actions, serializers, queries and tests that still use the old name or type.

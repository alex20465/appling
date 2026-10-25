---
title: Project layout
description: Where models live, how files load as one workspace, and which files Appling writes next to them.
---

An Appling project is a folder of `.appling` files plus a few files the tools write. Nothing else is required: no manifest, no build step.

## A typical project

```
my-app/
  appling.config.json        code generation targets and the AI model
  models/
    sales.appling            one or more modules per file
    crm.appling
  .appling/
    view.json                entity view options from the IDE
    releases/
      1.0.0.json             graph snapshot written by appling release
  build/
    shop/                    a generated project (one per target)
      .appling/
        tasks.json           the task registry of that project
        migrations.json      migration steps already applied to it
```

| Path | Written by | Commit it |
|---|---|---|
| `*.appling` | you, the IDE, the AI | yes, it is the source of truth |
| `appling.config.json` | you | yes |
| `.appling/view.json` | the IDE | yes, if your team should share the view options |
| `.appling/releases/*.json` | `appling release` | yes, edits compare against the latest release |
| `<out>/.appling/tasks.json` | `appling generate`, the registry tools | yes, with the generated project |
| `<out>/.appling/migrations.json` | `appling generate --migrate` | yes, with the generated project |

The tree assumes you run the tools from `my-app`: `appling release` writes into the current folder, and the IDE keeps `.appling/view.json` in the folder it serves. See [configuration and files](../reference/configuration.md) for the format of each.

## One workspace

Every command takes files or folders. Folders are searched recursively for `.appling` files; hidden folders and `node_modules` are skipped. Without a path, the current folder is used.

All files load as one workspace, so a module in one file can reference what another module exports in a different file. How you split modules over files does not matter to the model:

```sh
npx appling check models          # every file below models/
npx appling check models/sales.appling models/crm.appling
```

The repository's [examples](../../examples/sales.appling) do exactly this: `sales` references `crm.Account` and `crm.Clerk` from [crm.appling](../../examples/crm.appling).

## Identity

Every element is identified by its qualified name: the module path, then the path inside the module, such as `sales.Order.status`. Elements without a name, such as invariants or transitions, get a key derived from their content, such as `sales.OrderFlow.transition[draft,placed->cancelled]`. There are no hidden ids; renames are tracked through [migration steps](../language/migrations.md) once a release exists.

## Version control

Commit the text. The graph, the layout and generated code are derived from it, and the canonical formatting of `appling fmt` keeps diffs small: an edit from the IDE or the AI touches only the lines it changes.

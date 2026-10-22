---
title: Configuration
description: The appling.config.json file and every file Appling writes into .appling folders, with their exact shapes.
---

Appling keeps the model in `.appling` files and everything else out of them. Project settings live in `appling.config.json`. Tools write their own state into hidden `.appling` folders: one in your workspace (layout and releases) and one in each generated project (task registry and applied migrations). Hidden folders are never searched for model files.

## appling.config.json

One JSON file in the project root with two optional sections:

```json
{
  "generate": [
    { "extension": "@appling/codegen-django", "out": "build/shop", "options": { "name": "shop" } },
    { "extension": "@appling/codegen-ash", "out": "build/shop_ash" }
  ],
  "ai": { "provider": "anthropic", "model": "claude-opus-5-5" }
}
```

Each tool looks for the file in a specific place:

| Tool | Reads | From |
|---|---|---|
| `appling generate` | `generate` | `./appling.config.json` in the current folder |
| MCP server registry tools | `generate` | `appling.config.json` in the server's workspace folder |
| IDE chat | `ai` | `appling.config.json` in the IDE's workspace folder |

Keep the file in the folder you run the CLI from and open in the IDE, so all tools agree.

### generate

A list of targets. `appling generate` produces one project per target, in order, and stops at the first one that fails.

| Key | Type | Meaning |
|---|---|---|
| `extension` | string, required | The package of the code generation extension, such as `@appling/codegen-django`. It is resolved like a Node import from the folder of `appling.config.json`, so install it in the project. The package exports the extension as default |
| `out` | string, required | The output folder, relative to the current folder for the CLI and to the workspace folder for the MCP server. It must be missing or empty for `appling generate` |
| `options` | object, optional | Passed to the extension as `context.options` |

The built in extensions read one option:

| Option | Extensions | Meaning |
|---|---|---|
| `name` | all (read by the code generation core) | The project name, available to the extension as `context.name`. Default: the name of the `out` folder |

| Extension | Notes |
|---|---|
| `@appling/codegen-django` | The name becomes the uv project name (`uv init --bare --name <name>`). Needs `uv` |
| `@appling/codegen-ash` | The project is created with `mix igniter.new <name>` next to the output folder, so the name must equal the `out` folder's name; leave `name` out. Needs Elixir 1.17 or later and the `igniter_new` archive |

What each extension generates is described in [Django](../codegen/django.md) and [Ash](../codegen/ash.md). Third party extensions may read more options; see [Writing extensions](../codegen/extensions.md).

### ai

The model of the IDE chat. Both keys are optional and fall back to their defaults one by one.

| Key | Values | Default |
|---|---|---|
| `provider` | `anthropic` or `openai` | `anthropic` |
| `model` | A model id of the provider | `claude-opus-5-5` |

API keys never go into this file. They come from the environment of the IDE: `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. See [AI tools](../tools/ai.md#ide-chat).

## The workspace .appling folder

Next to your models, in the workspace folder:

```
.appling/
  layout.json
  releases/
    1.0.0.json
```

### Layout

`.appling/layout.json` holds the IDE's view state: card positions and the layers the graph shows. The IDE creates it when you move a card or change the layers. It never affects the model.

```json
{
  "positions": {
    "medium": {
      "sales.Order": { "x": 0, "y": 6.67 },
      "sales.OrderFlow": { "x": 17.14, "y": 167.2 }
    },
    "in": {
      "sales.Order": { "x": 0, "y": 6.67 }
    }
  },
  "layers": ["domain", "behavior"]
}
```

| Key | Meaning |
|---|---|
| `positions` | Per zoom level (`out`, `medium`, `in`), a map from qualified name to `{ x, y }`, relative to the module that contains the card. Only cards you moved are listed |
| `layers` | The layers shown at the declaration and member levels: any of `domain`, `behavior`, `application`, `interface`, `experience`, `cross`. Missing means `["domain"]` |

Positions follow renames made in the IDE and renames recorded as migration steps.

### Releases

`appling release <version>` writes `.appling/releases/<version>.json`. A release is never overwritten.

```json
{
  "version": "1.0.0",
  "created": "2026-10-23T10:15:00.000Z",
  "graph": {
    "nodes": [
      { "qn": "sales.Order", "kind": "Entity", "layer": "domain", "level": "medium", "module": "sales", "props": {}, "data": {} }
    ],
    "edges": [
      { "from": "sales", "to": "sales.Order", "kind": "contains" }
    ]
  }
}
```

| Key | Meaning |
|---|---|
| `version` | `major.minor.patch`, such as `1.0.0` |
| `created` | When the release was written, as an ISO timestamp |
| `graph` | The [semantic graph](graph.md) at that point: `nodes` and `edges`, without `dependencies` |

The IDE, the MCP server and the IDE chat use the release with the highest version. When you rename, retype or remove a domain element that exists in it, the edit appends a migration step to the module's `since_v<version>` block. See [Edit operations](edit-operations.md#release-aware-edits).

Commit the releases folder: it is the record of what your generated projects and databases were built from.

## The generated project's .appling folder

`appling generate` creates an `.appling` folder inside each output folder:

```
build/shop/
  .appling/
    tasks.json
    migrations.json
```

### tasks.json

The task registry: one entry per graph node, with what was generated and what is still open. `appling generate` writes it; `appling generate --migrate` adds tasks to it; the MCP tool `registry_update` records progress in it.

```json
{
  "extension": "@appling/codegen-django",
  "test": ["uv", "run", "python", "manage.py", "test"],
  "entries": {
    "sales.Order.invariant[\"total never negative\"]": {
      "qn": "sales.Order.invariant[\"total never negative\"]",
      "kind": "Invariant",
      "layer": "domain",
      "status": "partial",
      "steps": [
        "template: sales/tests.py",
        "task: write the test bodies of OrderTotalNeverNegativeTest in sales/tests.py"
      ],
      "files": ["sales/tests.py"],
      "missing": [
        {
          "what": "write the test bodies of OrderTotalNeverNegativeTest in sales/tests.py",
          "context": {
            "props": { "label": "total never negative", "condition": "total >= 0" },
            "related": [{ "qn": "sales.Order.total", "kind": "Field", "edge": "uses" }]
          }
        }
      ],
      "attempts": 1,
      "notes": ["the test for a negative total needs a way to create lines"]
    }
  }
}
```

| Key | Meaning |
|---|---|
| `extension` | The extension's name |
| `test` | The command that runs the project's tests, from the project root |
| `entries` | A map from qualified name to entry |

Each entry:

| Key | Meaning |
|---|---|
| `qn`, `kind`, `layer` | The graph node |
| `status` | `generated`, `partial` (generated with open tasks), `todo` (nothing generated) or `done` (open work finished) |
| `steps` | One line per step that produced the element, as `appling generate --plan` prints them |
| `files` | The files those steps wrote or created |
| `missing` | The open tasks: `what` to do, and the `context` with the element's `props` and its `related` elements; `edge` is the reference kind, with ` by` appended for incoming references |
| `attempts` | How often someone tried to finish the open work (set by `registry_update`) |
| `notes` | Notes left by those attempts |

How the registry drives the remaining work is described in [Task registry](../codegen/registry.md).

### migrations.json

The migration steps already carried into the project by `appling generate --migrate`, as a list of ids:

```json
[
  "sales.since_v1_0_0#0",
  "sales.since_v1_0_0#1"
]
```

An id is the qualified name of the migration block, `#`, and the step's position in it, counting from 0. Steps listed here are never applied again, so do not reorder or remove steps in a block after you migrated a project from it. See [Migrations in generated projects](../codegen/migrations.md).

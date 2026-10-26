---
title: Command line
description: The appling command checks, formats, inspects, releases and generates code from your models.
---

The `appling` command line tool is the package `@appling/cli`. It validates `.appling` files, rewrites them into canonical form, prints the semantic graph, records releases and runs code generation. Every command reads the files you give it as one workspace, so references between modules resolve across files.

## Install

```sh
npm install --save-dev @appling/cli
```

Or run it without installing:

```sh
npx @appling/cli check models
```

## Usage

```sh
appling check [files or folders...]
appling fmt   [files or folders...]
appling graph [files or folders...]
appling release <version> [files or folders...]
appling generate [--plan | --migrate | --sync] [files or folders...]
appling simulate <reach <machine> <state> | actors <action> | risks <action>> [files or folders...]
appling refs <qualified name | --check> [files or folders...]
```

### How files are found

| Argument | Meaning |
|---|---|
| none | The current folder |
| a file | That file, whatever its extension |
| a folder | Every `.appling` file below it, searched recursively |

Folder searches skip hidden folders (names starting with `.`, such as `.appling` or `.git`) and `node_modules`. All files found load into one workspace before anything else happens, so `sales.appling` can reference `crm.Account` from `crm.appling`.

> [!IMPORTANT]
> `release` and `generate` work relative to the current folder, not to the paths you pass. `release` writes to `./.appling/releases/`, and `generate` reads `./appling.config.json`. Run them from your project root.

### Diagnostics

`check`, `graph`, `release` and `generate` print one line per problem in the form `file:line:column severity message`, with the file relative to the current folder:

```
models/sales.appling:13:23 error A machine must govern an entity field marked "state" with an enum type.
```

The severity is `error` or `warning`. Only errors change the exit code. The full list of rules is on [Validation](../language/validation.md).

## check

Parses, links and validates every file, prints each diagnostic, then a summary line.

```sh
appling check examples
```

```
2 file(s), 0 error(s)
```

`check` prints diagnostics on stdout. It exits with 1 when there is at least one error.

## fmt

Rewrites every file into canonical form: whitespace, indentation (two spaces) and line breaks are normalized, comments are kept. It prints `formatted <file>` for each file it changed and stays silent for files that were already canonical.

```sh
appling fmt examples
```

`fmt` only needs a file to parse. It skips files with syntax errors, leaves them untouched and reports them on stderr:

```
models/sales.appling: not formatted, fix syntax errors first (run "appling check")
```

`fmt` is idempotent: running it a second time changes nothing. The language server formats with the same printer, see [Editors](editors.md).

## graph

Validates the workspace, then prints the semantic graph as JSON on stdout: every element as a node, every reference as an edge, and the module to module dependencies.

```sh
appling graph examples > graph.json
```

```json
{
  "nodes": [{ "qn": "sales.Order.status", "kind": "Field", "layer": "domain", "level": "in", "module": "sales", "props": { "type": "OrderStatus", "modifiers": ["state"], "default": "draft" }, "data": { "...": "..." } }],
  "edges": [{ "from": "sales.Order.status", "to": "sales.OrderStatus", "kind": "type" }],
  "dependencies": [{ "from": "sales", "to": "crm", "count": 1 }]
}
```

When the model has errors, `graph` prints them on stderr, writes nothing to stdout and exits with 1. The JSON format is described field by field in [Semantic graph](../reference/graph.md).

## release

Validates the workspace and writes a snapshot of its semantic graph to `.appling/releases/<version>.json` in the current folder.

```sh
appling release 1.0.0
```

```
released 1.0.0 to .appling/releases/1.0.0.json
```

The version must have the form `major.minor.patch` with numbers only, such as `1.2.3`. `release` refuses a model with errors, an invalid version and a version that already exists; it never overwrites a release.

Once a release exists, the tools that edit the model (the [IDE](ide.md) and the [AI tools](ai.md)) record renames, type changes and removals of released domain elements as migration steps in one block per module named after the release, such as `migration since_v1_0_0`. See [Edit operations](../reference/edit-operations.md#release-aware-edits) and [Migrations](../language/migrations.md). The file format is on [Configuration](../reference/configuration.md#releases).

## generate

Generates a draft project for every target in `appling.config.json` through the target's code generation extension. The model must be free of errors.

```json
{
  "generate": [
    { "extension": "@appling/codegen-django", "out": "build/shop", "options": { "name": "shop" } }
  ]
}
```

```sh
appling generate examples
```

For each target, `generate`:

1. Loads the extension package named in `extension`, resolved from the current folder.
2. Checks the tools the extension needs (for example `uv` for Django) and stops with a hint for each one that is missing.
3. Refuses to run when the `out` folder exists and is not empty. Generation creates a new draft project once.
4. Runs the planned steps into `out`, printing one line per step, and writes the task registry `.appling/tasks.json` into it.
5. Prints a summary such as `12 element(s): 11 generated, 1 partial, 0 todo`.

Without targets in the configuration, `generate` prints how to add one and exits with 1. The extensions are described in [Code generation](../codegen/overview.md), the configuration in [Configuration](../reference/configuration.md).

### Plan

Prints the steps for every target without running anything, so no prerequisites are checked and no folder is touched. Each line names the element (or `(project)` for setup steps) and the step:

For the model on [Semantic graph](../reference/graph.md#example) (the modules `crm` and `sales`) and the Django target above:

```sh
appling generate --plan
```

```
@appling/codegen-django -> build/shop
  (project): command: uv init --bare --name shop
  (project): command: uv add django~=6.1.0
  (project): command: uv run django-admin startproject config .
  crm: command: uv run python manage.py startapp crm
  crm: template: config/settings.py
  sales: command: uv run python manage.py startapp sales
  sales: template: config/settings.py
  crm.Account: template: crm/models.py
  sales.OrderStatus: template: sales/enums.py
  sales.Order: template: sales/models.py
  sales.Order.invariant["total never negative"]: template: sales/tests.py
  (project): command: uv run python manage.py makemigrations
12 element(s): 11 generated, 1 partial, 0 todo
```

`partial` means the element was generated with open tasks; here the invariant got a skipped test whose body is a registry task. See [Task registry](../codegen/registry.md).

### Migrate

Carries the model's migration steps that a generated project has not applied yet into it. Renames, type changes and removals become framework migrations that keep the data (a rename stays a rename, not a drop and an add), the generated model code changes with them, and the rest of the work becomes registry tasks.

```sh
appling generate --migrate examples
```

```
build/shop: 2 migration step(s) applied, 1 task(s) added to the registry
```

The target must have been generated first (it needs `.appling/tasks.json` in `out`). Applied steps are recorded by id in the project's `.appling/migrations.json`, so each step is applied once. When nothing is pending, it prints `build/shop: no pending migration steps`. See [Migrations in generated projects](../codegen/migrations.md).

### Sync

Brings a generated project up to the current model and keeps the work done in it since. It applies pending migration steps first (as `--migrate`), generates the model afresh in a temporary folder, and merges every file three ways. See [Sync](../codegen/sync.md).

```sh
appling generate --sync examples
```

```
conflicts: internal/sales/types.go
build/shop: synced, 1 file(s) with conflict markers (registry tasks)
```

The target must have been generated with a version of appling that stores the generation baseline in `.appling/baseline/`.

`--plan`, `--migrate` and `--sync` must come directly after `generate`, before any path.

## simulate

```sh
appling simulate reach <machine> <state> [paths...]
appling simulate actors <action> [paths...]
appling simulate risks <action> [paths...]
```

Asks the [simulator](simulator.md) about the model's behavior. The model must be valid.

```
$ appling simulate reach sales.OrderFlow paid examples
paid is reachable from draft:
  PlaceOrder -> placed
  PaymentReceived -> paid

$ appling simulate actors sales.Cancel examples
sales.Shopper: no

$ appling simulate risks sales.PlaceOrder examples
no invariant reads a field this action changes
```

## refs

```sh
appling refs <qualified name> [paths...]
appling refs --check [paths...]
```

Prints the [code references](references.md) of the workspace in the current folder (`.appling/references.json`): where elements are implemented, by file and line range. The model must be valid. With a qualified name, it prints the references of that element and its members, each with its status when it is not `current`:

```
$ appling refs sales.Order
../shop/sales/models.py:14-31 sales.Order
../shop/sales/permissions.py:12-24 sales.Order.policy[create,update,delete] (shifted)
```

With `--check`, it prints every reference that is `shifted`, `broken` or `orphaned`, then the counts, and exits with 1 when there is one:

```
$ appling refs --check
../shop/sales/models.py:16-33 sales.Order: shifted from 14-31
../shop/sales/views.py:40-52 sales.Archive: orphaned, no such element in the model
3 reference(s), 1 shifted, 0 broken, 1 orphaned
```

## Exit codes

| Code | Meaning |
|---|---|
| 0 | No errors |
| 1 | `check`, `graph`, `release`, `generate` or `refs` found errors in the model; `refs --check` found a reference that is not current; `release` got an invalid or existing version; `generate` has no targets, a missing prerequisite, a non empty output folder, a failing step, or (with `--migrate`) a target that was not generated; `fmt` skipped a file with syntax errors |
| 2 | Unknown command, `release` without a version, `refs` without a qualified name or `--check`, or `simulate` without a known question and its arguments |

Exit code 2 also prints the usage.

## Examples

Validate everything below the current folder in CI:

```sh
npx @appling/cli check
```

Format the models before committing:

```sh
appling fmt models
```

List every entity of the model with [jq](https://jqlang.org):

```sh
appling graph models | jq -r '.nodes[] | select(.kind == "Entity") | .qn'
```

Release, keep editing, then bring a generated project up to date:

```sh
appling release 1.0.0 models
# rename or retype released fields in the IDE or with the AI tools
appling generate --migrate models
```

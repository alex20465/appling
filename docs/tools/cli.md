---
title: Command line
description: The appling command checks, formats, inspects, releases and generates code from your models and opens them in the IDE.
---

The `appling` command line tool is the package `@appling/cli`. It validates `.appling` files, rewrites them into canonical form, prints the semantic graph, records releases, runs code generation and opens the IDE in your browser. Every command reads the files you give it as one workspace, so references between modules resolve across files.

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
appling init [folder] [--name <name>] [--agents <agents>] [--stack <stack>]
appling ide [folder]
appling check [files or folders...]
appling fmt   [files or folders...]
appling graph [files or folders...]
appling release <version> [files or folders...]
appling generate [--plan | --coverage [--json] | --migrate | --sync] [files or folders...]
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

## init

Sets up a project for Appling and connects coding agents to it. It creates the folder when needed, writes `package.json` when there is none, installs `@appling/cli`, `@appling/ai` and the stack's code generation extension as development dependencies, then writes the starter model, the generate target and each agent's configuration. [Start a new project](../getting-started/new-project.md) lists every file it writes.

```sh
appling init [folder] [--name <name>] [--agents <agents>] [--stack <stack>]
```

| Argument | Default | Meaning |
|---|---|---|
| `folder` | the current folder | The project folder |
| `--name` | asked | The project name: lower case letters, digits, `-` and `_`, starting with a letter |
| `--agents` | asked | A comma separated list of `claude`, `codex`, `opencode`, `gemini` and `antigravity` |
| `--stack` | asked | `django`, `ash`, `go`, `rust`, or `none` to decide later |

`init` asks for what the flags leave open. Without a terminal it asks nothing and exits with 2 unless all three flags are given. The package manager is the one of the project's lockfile, else the one that ran `init` (`pnpm dlx`, `yarn dlx`, `bunx`), else npm. Running `init` again keeps existing settings and changes nothing. Besides the agents' files it writes `appling.config.json` (empty with `--stack none`) and adds the missing lines to `.gitignore`: `node_modules/`, `.appling/view.json` and the stack's local files in its output folder (see [What it writes](../getting-started/new-project.md#what-it-writes)).

```sh
npx @appling/cli init todo --name todo --agents claude,codex --stack none
```

```
Appling is set up for Claude Code, Codex. Start your agent in todo and describe the application you want.
```

## ide

Opens the [repo view](ide.md) of a folder in your browser, the same view Appling Desktop and the VS Code extension show: the model canvas, the search, the inspector and the editor behind **Source**. It starts the IDE server for the folder (the current folder without one) on a free port of `127.0.0.1`, prints its address and opens it in your default browser. It runs until you press Ctrl+C.

```sh
appling ide examples
```

```
Appling IDE for /home/you/project/examples at http://127.0.0.1:38543
Press Ctrl+C to stop.
```

If no browser opens, open the printed address yourself. The browser tab has no terminals, agent sessions or code view; those come with [Desktop](desktop.md).

## check

Parses, links and validates every file, prints each diagnostic, then a summary line.

```sh
appling check examples
```

```
2 file(s), 0 error(s)
```

Once the model has no errors, `check` runs every [scenario](../language/scenarios.md) in the [simulator](simulator.md) and reports each one whose `then` does not hold as an error at the scenario's name:

```
examples/sales.appling:127:12 error Scenario ClerkCancelsDraft fails: order.status == placed is false.
2 file(s), 1 error(s)
```

`check` prints diagnostics on stdout. It exits with 1 when there is at least one error, a failing scenario included. `graph`, `release` and `generate` do not run the scenarios.

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
5. Records the [code references](references.md) of the code it wrote in `.appling/references.json` and the fingerprints of the generated elements in `.appling/generation.json`, both in the current folder, so the IDE knows what is [implemented and what changed since](implementation.md#generation-records).
6. Prints a summary such as `12 element(s): 11 generated, 1 partial, 0 todo`.

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

| kind | generated | partial | todo | tasks | left to code |
|---|---|---|---|---|---|
| Entity | 2 | 0 | 0 | 0 | 0 |
| Enum | 1 | 0 | 0 | 0 | 0 |
| EnumLiteral | 2 | 0 | 0 | 0 | 0 |
| Field | 4 | 0 | 0 | 0 | 0 |
| Invariant | 0 | 1 | 0 | 1 | 0 |
| Module | 2 | 0 | 0 | 0 | 0 |
| **total** | 11 (92%) | 1 | 0 | 1 | 0 |

12 element(s): 11 generated, 1 partial, 0 todo
```

After the steps, a Markdown table counts the registry entries per element kind by status, with the number of registry tasks they leave; the total row gives the generated share. Tasks are generator gaps. Work the model leaves to the code by design (an external system's client, a webhook's signature check, a cron entry, a [`does`](../language/descriptions.md) text) counts under `left to code`, and an element whose only open work is left to code counts as generated. The summary line below the table counts the registry statuses, which still list that work. `partial` means the element was generated with open tasks; here the invariant got a skipped test whose body is a registry task. See [Task registry](../codegen/registry.md).

### Coverage

Plans every target without running anything, like `--plan`, and prints only how much of the model each extension generates: the share of elements that are `generated`, `partial` and `todo`, the completion and the registry tasks, then the same per element kind in a folded section per extension. With the Django and Ash targets on the examples:

```sh
appling generate --coverage examples
```

```
## Codegen coverage

**87.2%** generated completion, 37 registry tasks and 3 left to code, over model.

| extension | generated | partial | todo | completion | tasks | left to code |
|---|---|---|---|---|---|---|
| django | 83.3% | 15.3% | 1.4% | 91.0% | 13 | 2 |
| ash | 73.6% | 19.4% | 6.9% | 83.3% | 24 | 1 |

### Per node kind

<details>
<summary>django: 91.0% (model 91.0%)</summary>

| kind | generated | partial | todo | completion | tasks | left to code |
|---|---|---|---|---|---|---|
| Action | 2 | 0 | 0 | 100.0% | 0 | 0 |
| External | 1 | 0 | 0 | 100.0% | 0 | 1 |
...
| Policy | 0 | 7 | 0 | 50.0% | 7 | 0 |
...
</details>

Completion = (generated + partial / 2) / elements: a partial element has code and open registry tasks, so it counts as half. Tasks are generator gaps; work the model leaves to the code by design (`docs/concept.md` section 8) counts in left to code and does not lower the completion.
```

The output is Markdown, so it renders in a pull request or a job summary. The completion counts a `partial` element as half, because it has code and open tasks. Only generator gaps count: work the model leaves to the code does not lower it ([design concept, section 8](../concept.md#8-what-belongs-in-the-model)). `--coverage --json` prints the same report as JSON (`CoverageReport` of [`@appling/codegen`](../reference/api.md)). A target whose extension appears twice is planned once.

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

The target must have been generated with a version of appling that stores the generation baseline in `.appling/baseline/`. Like a first generation, sync records the code references and the fingerprints of what it generated.

The IDE generates the same way from its [Code tab](implementation.md#generate-from-the-ide), also for single elements or what changed since the last generation.

`--plan`, `--coverage` (with `--json` right after it), `--migrate` and `--sync` must come directly after `generate`, before any path.

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
crm.Employee: yes
sales.Shopper: no

$ appling simulate risks sales.PlaceOrder examples
no invariant reads a field this action changes
```

## refs

```sh
appling refs <qualified name> [paths...]
appling refs --check [paths...]
```

Prints the [code references](references.md) of the workspace in the current folder (`.appling/references.json`): where elements are implemented, by file and line range. The model must be valid. With a qualified name, it prints the references of that element, its members and its [sub-anchors](../reference/graph.md#sub-anchors) (such as `sales.Checkout#step[2]`), each with its status when it is not `current`:

```
$ appling refs sales.Order
../shop/sales/models.py:14-31 sales.Order
../shop/sales/permissions.py:12-24 sales.Order.policy[update] (shifted)
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
| 1 | `init` was cancelled or the installation failed; `ide` got a folder that does not exist or its server failed; `check`, `graph`, `release`, `generate` or `refs` found errors in the model; `refs --check` found a reference that is not current; `release` got an invalid or existing version; `generate` has no targets, a missing prerequisite, a non empty output folder, a failing step, or (with `--migrate`) a target that was not generated; `fmt` skipped a file with syntax errors |
| 2 | Unknown command, `init` with an unknown flag or an invalid `--name`, `--agents` or `--stack`, or without a terminal and not every flag given, `release` without a version, `refs` without a qualified name or `--check`, or `simulate` without a known question and its arguments |

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

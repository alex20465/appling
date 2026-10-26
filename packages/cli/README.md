# @appling/cli

Command line tool to check, format and inspect Appling models (`.appling` files).

Appling is a declarative language that describes a business or web application in five layers: domain, behavior, application, interfaces and experience. The language itself lives in [`@appling/lang`](https://www.npmjs.com/package/@appling/lang).

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
appling generate [--plan | --migrate] [files or folders...]
appling simulate reach <machine> <state> [files or folders...]
appling simulate actors <action> [files or folders...]
appling simulate risks <action> [files or folders...]
appling refs <qualified name | --check> [files or folders...]
```

Folders are searched recursively for `.appling` files. Hidden folders and `node_modules` are skipped. Without a path, the current folder is used.

All files are loaded as one workspace, so references between modules resolve across files.

### check

Parses, links and validates every file and prints one line per problem:

```
models/sales.appling:13:23 error A machine must govern an entity field marked "state" with an enum type.
2 file(s), 1 error(s)
```

### fmt

Rewrites every file into its canonical form:

- Normalizes whitespace, indentation and line breaks. Comments are kept.
- Running it twice changes nothing.

Files with syntax errors are left untouched and reported.

### graph

Prints the semantic graph of the model as JSON: every element as a node with its qualified name, kind, layer, zoom level, module and properties, every reference as an edge, and the module to module dependencies. Unnamed elements such as policies or transitions get a key derived from their content, for example `sales.Order.policy[read fields total]`.

```json
{
  "nodes": [{ "qn": "sales.Order.status", "kind": "Field", "layer": "domain", "level": "in", "module": "sales", "props": { "type": "OrderStatus", "modifiers": ["state"], "default": "draft" } }],
  "edges": [{ "from": "sales.Order.status", "to": "sales.OrderStatus", "kind": "type" }],
  "dependencies": [{ "from": "sales", "to": "crm", "count": 1 }]
}
```

When the model has errors, they are printed to stderr instead and nothing is written to stdout.

### release

Writes a snapshot of the semantic graph to `.appling/releases/<version>.json` in the current folder. The version looks like `1.2.3`. A model with errors is not released, and an existing version is never overwritten.

Once a release exists, tools that edit the model (the IDE, the AI) record renames, type changes and removals of released domain elements as migration steps, in one block per module named after the release, such as `migration since_v1_0_0`.

### generate

Generates a draft project for every target in `appling.config.json` through its code generation extension, and writes the task registry `.appling/tasks.json` into it. See [`@appling/codegen`](https://www.npmjs.com/package/@appling/codegen) for the configuration. With `--plan`, it prints the steps without running them.

Generation checks the tools the extension needs first and refuses to write into a folder that is not empty.

With `--migrate`, it carries the model's migration steps that a generated project has not applied yet into it: renames, type changes and removals become framework migrations that keep the data (a rename stays a rename, not a drop and an add), the generated model code changes with them, and updating the rest of the code becomes registry tasks. Applied steps are recorded in the project's `.appling/migrations.json`.

### simulate

Asks the simulator about behavior: whether a state of a machine is reachable and by which transitions, which actors may trigger an action (yes, no, or depending on the data), and which invariants an action puts at risk through the fields it changes.

```
$ appling simulate reach sales.OrderFlow paid models
paid is reachable from draft:
  PlaceOrder -> placed
  PaymentReceived -> paid
```

### refs

Prints the code references of the workspace in the current folder (`.appling/references.json`): where an element and its members are implemented, by file and line range. With `--check`, it lists every reference whose anchor line moved (`shifted`), whose file or anchor is gone (`broken`) or whose element the model no longer has (`orphaned`), and exits with 1 when there is one.

```
$ appling refs --check
../shop/sales/models.py:16-33 sales.Order: shifted from 14-31
1 reference(s), 1 shifted, 0 broken, 0 orphaned
```

## Exit codes

| Code | Meaning |
|---|---|
| 0 | No errors |
| 1 | `check`, `graph`, `release`, `generate` or `refs` found errors, `refs --check` found a reference that is not current, `release` found an invalid or existing version, `generate` failed, or `fmt` skipped a file with syntax errors |
| 2 | Unknown command, `release` without a version, or `refs` without a qualified name or `--check` |

## License

MIT

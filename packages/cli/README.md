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
appling generate [--plan] [files or folders...]
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

## Exit codes

| Code | Meaning |
|---|---|
| 0 | No errors |
| 1 | `check`, `graph`, `release` or `generate` found errors, `release` found an invalid or existing version, `generate` failed, or `fmt` skipped a file with syntax errors |
| 2 | Unknown command, or `release` without a version |

## License

MIT

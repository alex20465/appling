---
title: Writing an extension
description: How to write, package and test a third party code generation extension for a new target framework.
---

A code generation extension is a map, not a generator: for every node of the semantic graph it returns the steps that produce that node in the target framework. The core in `@appling/codegen` plans the steps, runs them and writes the [task registry](registry.md). This page shows the contract and a complete extension that writes a SQL schema.

## Package

Name the package `appling-codegen-<target>` or `@scope/appling-codegen-<target>`, and export the extension as the default export of its main module.

```json
{
  "name": "appling-codegen-sql",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": {
      "types": "./out/index.d.ts",
      "default": "./out/index.js"
    }
  },
  "files": ["out"],
  "dependencies": {
    "@appling/model": "^0.1.0"
  },
  "peerDependencies": {
    "@appling/codegen": "^0.1.0"
  },
  "devDependencies": {
    "@appling/codegen": "^0.1.0",
    "@appling/lang": "^0.1.0",
    "vitest": "^5.0.0"
  }
}
```

| Dependency | Why |
|---|---|
| `@appling/codegen` as a peer | The contract types, and the same core instance as the CLI that loads you |
| `@appling/model` | The graph types (`GraphNode`, `TypeData`, `ExprData`) |
| `@appling/lang` for development | Building models in memory in your tests |

The CLI resolves the `extension` of a target from the folder of `appling.config.json`, the way `require.resolve` does, and then imports it. Keep a `default` condition in `exports`: a map with only an `import` condition does not resolve. While you develop, a relative path works too:

```json
{
  "generate": [
    { "extension": "./codegen/sql.js", "out": "build/schema" }
  ]
}
```

## The contract

All types come from `@appling/codegen`:

```ts
interface CodegenExtension {
  name: string;
  prerequisites?: Prerequisite[];
  /** The command that runs the generated project's tests, from its root. */
  test?: string[];
  /** Paths sync never reads or writes, such as migration history, dependencies and build output (`**` and `*` globs). */
  syncExclude?: string[];
  /** Steps that run once, before any element, such as creating the project. */
  setup?(context: MapContext): Step[];
  steps(node: GraphNode, context: MapContext): Step[] | undefined;
  /** Steps that carry one Appling migration step into an already generated project. */
  migrate?(change: MigrationChange, context: MapContext, files: ProjectFiles): Step[];
}

type Step = CommandStep | TemplateStep | TaskStep;

interface CommandStep {
  kind: 'command';
  run: string[];
  cwd?: string;
  creates?: string[];
  /** Text fed to the command's standard input. */
  input?: string;
  phase?: number;
}

interface TemplateStep {
  kind: 'template';
  file: string;
  write: (existing: string | undefined) => string;
  phase?: number;
}

interface TaskStep {
  kind: 'task';
  what: string;
}

interface Prerequisite {
  name: string;
  command: string[];
  expect?: RegExp;
  hint: string;
  /** Whether this model needs the tool, such as Phoenix only for models with pages; by default every model does. */
  needed?: (graph: Graph) => boolean;
}

interface MapContext {
  graph: Graph;
  /** The project name: the `name` option, or the output folder's name. */
  name: string;
  options: Record<string, unknown>;
  node(qn: string): GraphNode | undefined;
  children(qn: string): GraphNode[];
  outgoing(qn: string, kind?: string): GraphEdge[];
  incoming(qn: string, kind?: string): GraphEdge[];
}
```

### steps

`steps(node, context)` is called once per graph node, in plan order: modules, then domain, cross cutting, behavior, application, interfaces and experience. What you return decides the node's registry entry:

| Return | Meaning | Registry status |
|---|---|---|
| `undefined` | You do not handle this kind | `todo`, with the task `<name> does not generate <Kind> yet` |
| `[]` | A parent's steps already cover the node, such as enum values written with their enum | `generated` |
| commands and templates | The node is produced | `generated` |
| commands or templates plus tasks | Produced, with open work | `partial` |
| only tasks | Nothing produced, open work recorded | `todo` |

### Step kinds

| Step | Behavior |
|---|---|
| `command` | Runs `run[0]` with the other items as arguments, without a shell: no pipes, no globs, no variables. `cwd` is relative to the output folder and is created when missing. `input` goes to standard input. The run stops at the first command that exits with a non zero code. `creates` lists files or folders for the registry entry. |
| `template` | Writes `file`, relative to the output folder, with what `write` returns. `write` gets the current content, or `undefined` when the file does not exist yet, so several steps can add to one file. Return the whole new content. |
| `task` | Never runs. Its `what` becomes an open task in the node's registry entry, with the node's properties and related elements as context. Write it as an instruction a person or an AI can act on. |

Prefer the target framework's own command line generators and patch their output with templates; the result then looks like a project a developer of that framework would start.

### setup

`setup(context)` returns steps that run once, before any node, such as creating the project. They appear in the plan under the node name `(project)`.

### Phases

Every command and template step can carry a `phase`. All steps of phase 0 (the default) run first, then phase 1, and so on; inside a phase, steps keep the plan order. Use a later phase for work that needs every element of an earlier one: relationships once every table or resource exists, or a final command that snapshots the finished project. Tasks have no phase.

### Prerequisites

Before a real run, `appling generate` runs each prerequisite's `command`. It passes when the command starts, exits with 0 and, when `expect` is set, its standard output and error match it. Otherwise the CLI prints `<name>: <hint>` and does not generate. `--plan` skips the check.

### test

`test` is the command that runs the generated project's tests, from its root. It is stored in the registry, and the `run_tests` tool of the [AI tools](../tools/ai.md) runs it.

### migrate

`migrate(change, context, files)` carries one model migration step into a project you generated earlier; see [migrating a generated project](migrations.md). Without it, `appling generate --migrate` fails for your target.

```ts
interface MigrationChange {
  /** Stable identity: the migration's qualified name and the step's position in it. */
  id: string;
  block: string;
  module: string;
  kind: 'rename' | 'retype' | 'remove';
  /** Qualified name before the step. */
  target: string;
  /** Qualified name now, after this and the later steps of the module; undefined when removed. */
  current?: string;
  /** Qualified name of the target's parent now. */
  parent?: string;
  newName?: string;
  oldType?: TypeData;
  newType?: TypeData;
  /** One timestamp for the whole run, such as 20261023101500, for migration file names. */
  stamp: string;
}

/** Read access to the generated project, for extensions that extend existing migration history. */
interface ProjectFiles {
  read(path: string): string | undefined;
  list(dir: string): string[];
}
```

`context` describes the model as it is now, so `context.node(change.current)` finds the element under its new name. `files` reads the generated project, for example to number a new migration after the existing ones. Return the migration and the code change as commands and templates, and the rest, such as updating code that uses the old name, as tasks. Identical commands of one run are run once, so several changes may each ask for the same final command.

## Read the graph, never the AST

An extension sees only the semantic graph from `@appling/model`. It never imports Langium or the AST of `@appling/lang`, so the language can change its grammar without breaking extensions.

```ts
interface GraphNode {
  qn: string;       // qualified name, such as "sales.Order.status"
  kind: string;     // "Entity", "Field", "Action", ...
  layer: Layer;     // "domain", "cross", "behavior", "application", "interface", "experience"
  level: Level;
  module: string;
  props: Record<string, unknown>;
  data: Record<string, unknown>;
}
```

Use `data`, not `props`. `props` holds display text: types and expressions as canonical Appling source. `data` holds the same properties for tools: references as qualified names, types as `TypeData`, expressions as `ExprData` trees.

```ts
interface TypeData {
  $type: 'TypeRef';
  primitive?: string;   // "String", "Int", "Money", ...
  decl?: string;        // qualified name of an enum, value type or entity
  many?: boolean;
  optional?: boolean;
}
```

An `ExprData` node has a `$type` (`BinaryExpr`, `UnaryExpr`, `NameExpr`, `MemberExpr`, `IndexExpr`, `ListExpr` or a literal), its operands, its `type` as text, and for names the `target`: the qualified name of the element the name stands for. Translate the cases you support and return a task for the rest. Use `props` only to quote the model in a task, such as `` `add a CHECK constraint for ${node.props.condition}` ``.

Navigate with the context: `children(qn)` for contained elements, `outgoing(qn, kind)` and `incoming(qn, kind)` for references by kind, `node(qn)` to look up an element. See [the semantic graph](../reference/graph.md) for every node kind and edge.

## A complete example

This extension writes one `schema.sql` with a table per entity. Fields that are not plain columns and invariants become tasks; a renamed field becomes an `ALTER TABLE` statement.

```ts
import type { CodegenExtension, MapContext, Step } from '@appling/codegen';
import type { GraphNode, TypeData } from '@appling/model';

const COLUMNS: Record<string, string> = {
  String: 'TEXT', Text: 'TEXT', Int: 'INTEGER', Decimal: 'NUMERIC', Money: 'NUMERIC',
  Bool: 'BOOLEAN', Date: 'DATE', DateTime: 'TIMESTAMP', Duration: 'INTERVAL', File: 'TEXT', Uuid: 'UUID'
};

const last = (qn: string) => qn.slice(qn.lastIndexOf('.') + 1);
const table = (entity: GraphNode) => `${entity.module.replaceAll('.', '_')}_${last(entity.qn).toLowerCase()}`;

function column(field: GraphNode, context: MapContext): string | undefined {
  const type = field.data.type as TypeData;
  if (field.data.derived || type.many) return undefined;
  const decl = type.decl ? context.node(type.decl) : undefined;
  const sql = type.primitive ? COLUMNS[type.primitive]
    : decl?.kind === 'Enum' ? 'TEXT'
    : decl?.kind === 'Entity' ? `UUID REFERENCES ${table(decl)}(id)`
    : undefined;
  return sql && `  ${last(field.qn)} ${sql}${type.optional ? '' : ' NOT NULL'}`;
}

function entitySteps(entity: GraphNode, context: MapContext): Step[] {
  const columns = context.children(entity.qn)
    .filter(child => child.kind === 'Field')
    .flatMap(field => column(field, context) ?? []);
  const sql = `CREATE TABLE ${table(entity)} (\n${['  id UUID PRIMARY KEY', ...columns].join(',\n')}\n);\n`;
  return [{ kind: 'template', file: 'schema.sql', write: existing => `${existing ?? ''}${sql}` }];
}

function fieldSteps(field: GraphNode, context: MapContext): Step[] | undefined {
  const owner = context.node(field.qn.slice(0, field.qn.lastIndexOf('.')))!;
  if (owner.kind !== 'Entity') return undefined;
  return column(field, context) ? [] : [{ kind: 'task', what: `store or compute ${last(field.qn)}: ${field.props.derived ?? field.props.type}` }];
}

const extension: CodegenExtension = {
  name: 'appling-codegen-sql',
  prerequisites: [{ name: 'psql', command: ['psql', '--version'], hint: 'install the PostgreSQL client' }],
  setup: () => [{ kind: 'template', file: 'schema.sql', write: () => '-- Generated by appling-codegen-sql\n' }],
  steps(node, context) {
    switch (node.kind) {
      case 'Module':
      case 'Enum':
      case 'EnumLiteral':
        return [];
      case 'Entity': return entitySteps(node, context);
      case 'Field': return fieldSteps(node, context);
      case 'Invariant': return [{ kind: 'task', what: `add a CHECK constraint for ${node.props.condition}` }];
      default: return undefined;
    }
  },
  migrate(change, context) {
    const parent = change.parent ? context.node(change.parent) : undefined;
    if (change.kind !== 'rename' || parent?.kind !== 'Entity') {
      return [{ kind: 'task', what: `carry the ${change.kind} of ${change.target} into the schema` }];
    }
    const sql = `ALTER TABLE ${table(parent)} RENAME COLUMN ${last(change.target)} TO ${change.newName};\n`;
    return [{ kind: 'template', file: `migrations/${change.stamp}_${change.block}.sql`, write: existing => `${existing ?? ''}${sql}` }];
  }
};

export default extension;
```

Everything the extension does not name, such as actions, queries or pages, returns `undefined` and shows up as a `todo` entry. That keeps the registry an honest coverage report while you add kinds one by one.

## Test in memory

Test the map without running commands, the way the built in extensions do: build the model in memory with `buildSources` from `@appling/lang`, turn it into a graph, call `plan`, and apply the template steps to a `Map` instead of the disk. Assert on file contents and on registry entries. For `migrate`, `pendingChanges` and `planMigrations` give the steps of a migration block.

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { buildSources, errorsOf, type Model } from '@appling/lang';
import { buildGraph } from '@appling/model';
import { pendingChanges, plan, planMigrations } from '@appling/codegen';
import sql from '../src/index.js';

async function graphOf(text: string) {
  const workspace = await buildSources({ 'file:///shop.appling': text });
  expect(errorsOf(workspace)).toEqual([]);
  return buildGraph(workspace.documents.map(d => d.parseResult.value as Model), workspace.services);
}

/** Applies the template steps in memory, without running commands. */
function render(steps: ReturnType<typeof plan>['steps']): Map<string, string> {
  const files = new Map<string, string>();
  for (const { step } of steps) {
    if (step.kind === 'template') files.set(step.file, step.write(files.get(step.file)));
  }
  return files;
}

test('entities become tables, the rest becomes tasks', async () => {
  const graph = await graphOf(`module shop {
  enum Status {
    open
    done
  }

  entity Customer {
    name: String
  }

  entity Order {
    customer: Customer
    status: Status
    note: Text?
    lines: String[]
    invariant "has lines" { lines.size() > 0 }
  }
}`);
  const result = plan(graph, sql, 'shop');
  expect(render(result.steps).get('schema.sql')).toBe([
    '-- Generated by appling-codegen-sql',
    'CREATE TABLE shop_customer (',
    '  id UUID PRIMARY KEY,',
    '  name TEXT NOT NULL',
    ');',
    'CREATE TABLE shop_order (',
    '  id UUID PRIMARY KEY,',
    '  customer UUID REFERENCES shop_customer(id) NOT NULL,',
    '  status TEXT NOT NULL,',
    '  note TEXT',
    ');',
    ''
  ].join('\n'));
  const status = Object.fromEntries(result.entries.map(e => [e.qn, e.status]));
  expect(status['shop.Order']).toBe('generated');
  expect(status['shop.Order.lines']).toBe('todo');
  expect(status['shop.Order.invariant["has lines"]']).toBe('todo');
});

test('a renamed field becomes ALTER TABLE', async () => {
  const graph = await graphOf(`module shop {
  entity Order {
    reference: String
  }

  migration since_v1_0_0 {
    rename Order.number -> reference
  }
}`);
  const changes = pendingChanges(graph, [], '20261023000000');
  const out = mkdtempSync(join(tmpdir(), 'appling-sql-'));
  const migration = planMigrations(graph, sql, 'shop', {}, out, changes);
  expect(render(migration.steps).get('migrations/20261023000000_since_v1_0_0.sql'))
    .toBe('ALTER TABLE shop_order RENAME COLUMN number TO reference;\n');
});
```

When a template patches a file that a command creates, as `manage.py startapp` creates `models.py`, seed the `Map` with a realistic copy of that file before you apply the steps. Run a real generation into a scratch folder only for an end to end check, since commands usually need the network.

# @appling/codegen

The core of Appling code generation. It turns the semantic graph of a model into a draft project for a target framework through an extension, and records in a task registry what was generated and what is still open.

Generation runs once per project. Work the generator cannot do (derived logic, complex preconditions, test bodies) becomes a registry task for the AI or a human, never a placeholder in the code.

## Configuration

`appling.config.json` in the project root:

```json
{
  "generate": [
    { "extension": "@appling/codegen-django", "out": "build/shop", "options": { "name": "shop" } }
  ]
}
```

`appling generate --plan` prints the steps, `appling generate` runs them into each `out` folder, which must be empty or missing.

## Writing an extension

An extension is a map, not a generator: for every graph node it returns the steps that produce it. It depends only on the `@appling/model` graph types, never on the Langium AST.

```ts
import type { CodegenExtension } from '@appling/codegen';

const extension: CodegenExtension = {
  name: 'my-target',
  prerequisites: [{ name: 'python', command: ['python3', '--version'], expect: /Python 3\.1[2-9]/, hint: 'install Python 3.12 or later' }],
  steps(node, context) {
    switch (node.kind) {
      case 'Module': return [{ kind: 'command', run: ['tool', 'new', context.name] }];
      case 'Entity': return [{ kind: 'template', file: 'models.py', write: existing => (existing ?? '') + '...' }];
      case 'Field': return [];
      case 'Invariant': return [{ kind: 'task', what: 'translate the condition' }];
      default: return undefined;
    }
  }
};
export default extension;
```

| Step | Does |
|---|---|
| `command` | Runs the framework's own command line tool, `cwd` relative to the output folder |
| `template` | Writes or patches a file; `write` gets the current content |
| `task` | Records open work in the registry |

Returning `undefined` marks the node kind as not supported (a `todo` entry); an empty list means a parent's steps already cover the node. Nodes are planned in dependency order: modules, then domain, cross cutting, behavior, application, interfaces, experience.

Third party extensions are named `appling-codegen-*` or `@scope/appling-codegen-*`, have a peer dependency on `@appling/codegen` and export the extension as default.

## Registry

`.appling/tasks.json` in the generated project holds one entry per qualified name:

| Field | Meaning |
|---|---|
| `status` | `generated`, `partial` (generated with open tasks), `todo`, or `done` once the open work is finished |
| `steps`, `files` | What produced the element |
| `missing` | Open tasks with their model context: the element's properties and related elements |

Every graph node has an entry, so the registry is also the coverage report and the AI work queue.

## API

| Export | Purpose |
|---|---|
| `plan(graph, extension, name, options)` | The ordered steps and registry entries |
| `runPlan(plan, out, log)` | Runs the steps and writes the registry |
| `checkPrerequisites(prerequisites)` | Messages for missing tools |
| `readConfig(root)`, `loadExtension(name, root)` | Configuration and extension loading |
| `describe(step)` | A one line description of a step |

## License

MIT

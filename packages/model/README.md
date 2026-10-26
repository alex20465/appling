# @appling/model

The semantic graph of an Appling model and the edit operations that change it. Every element is a node, every reference an edge, and module dependencies are computed from them. Visualization, AI and code generation all read this graph and change the model through these operations.

## API

```ts
import { buildGraph, dependencies } from '@appling/model';

const graph = buildGraph(models, services); // resolved Model roots and the Appling services from @appling/lang
const deps = dependencies(graph);
```

| Export | Purpose |
|---|---|
| `buildGraph(models, services)` | Nodes and edges of resolved models, in document order |
| `dependencies(graph)` | Module to module dependencies with the number of references behind each |
| `isElement(node)` | Whether an AST node becomes a graph node |
| `qualifiedNames(models)` | The qualified name of every element AST node, in document order |
| `parentElement(node, qns)` | The nearest element containing a node |
| `applyEdit(sources, operation, { release })` | Applies one edit operation to sources keyed by URI |
| `writeRelease(root, version, graph)`, `readReleases(root)`, `latestRelease(releases)` | Release snapshots in `<root>/.appling/releases/` |
| `migrationBlockName(version)` | The migration block for steps after a release, such as `since_v1_0_0` |
| `recordReferences(root, qn, ranges)`, `readReferences(root)`, `resolveReferences(root, graph?)` | Code references in `<root>/.appling/references.json`: where elements are implemented, by file, line range and anchor line, resolved as `current`, `shifted`, `broken` or `orphaned` |
| `Graph`, `GraphNode`, `GraphEdge`, `Dependency` | The serializable graph types |

In a browser bundle, import the graph from `@appling/model/graph` and the edit operations from `@appling/model/edit`; the package root also loads the file system functions.

### Nodes

| Field | Meaning |
|---|---|
| `qn` | Qualified name, such as `sales.Order.status` |
| `kind` | The AST type, such as `Field` |
| `layer` | `cross`, `domain`, `behavior`, `application`, `interface` or `experience` |
| `level` | Zoom level: `out` for modules and use cases, `medium` for other top level declarations, `in` for nested elements |
| `module` | Qualified name of the owning module |
| `props` | For display: scalar properties, plus nested non element parts (types, expressions, preconditions, steps) as canonical text |
| `data` | For tools: the same properties with references as qualified names and nested parts as objects with `$type`; expressions also carry their `type` and, for names, the `target` they stand for |

Unnamed elements get a key derived from their content: `invariant["total never negative"]`, `policy[read fields total]`, `transition[draft,placed->cancelled]`, `endpoint[GET /orders]`, `effect[set placed_at]`. Duplicate keys among siblings get an ordinal, such as `policy[read]#2`.

### Edges

`contains` links an element to its children. `uses` links an element to what the names in its expressions stand for, such as a field, an enum value or a role. Every other edge is a reference, named after the referencing property: `type`, `entity`, `action`, `event`, `target`, `projection` and so on.

## Edit operations

```ts
import { applyEdit } from '@appling/model';

const result = await applyEdit(sources, { op: 'rename', target: 'sales.Order.total', name: 'amount' });
if (result.ok) {
  result.edits;   // minimal text edits: { uri, offset, length, text }
  result.sources; // the changed texts
} else {
  result.errors;  // why the edit was rejected
}
```

| Operation | Does |
|---|---|
| `{ op: 'add', parent, source }` | Inserts a declaration, such as `note: Text?` or `requires { ... } else E`, at the last position inside the parent where it parses |
| `{ op: 'rename', target, name }` | Renames the element and everything that names it: references (also as part of qualified names such as `crm.Account`), names in expressions, transitions over a renamed enum value, export lists, message keys, and projection fields copied from a renamed field |
| `{ op: 'retype', target, type }` | Replaces the type of a field or parameter |
| `{ op: 'remove', target }` | Removes the element, with its separating comma in a list and its name in the module's export list |
| `{ op: 'set', target, property, value }` | Replaces a property's text, removes it (with its keyword) when the value is empty, or inserts it with its keyword when it is absent |

When `release` is given, renaming, retyping or removing a domain (L1) element that exists in that release also appends a migration step (`rename Order.code -> reference`, `retype Order.total: Decimal -> Money`, `remove Order.legacy`) to the module's `since_v<version>` block, creating it when needed. Elements renamed since the release are traced back through the steps already in that block.

The touched element is printed canonically, so a formatted file stays formatted. An edit is rejected when it does not parse or when validation reports an error that was not there before.

## Simulator

`Simulator` evaluates behavior against sample data and actors (`import { Simulator } from '@appling/model'`, or `@appling/model/simulator` without the language dependencies):

```ts
const simulator = new Simulator(graph);
simulator.reach('sales.OrderFlow', 'paid');    // shortest transition path from the initial state, or undefined
simulator.actors('sales.Cancel');              // per actor: 'yes', 'no' or 'depends' (on the data)
simulator.access('sales.Shopper');            // what one actor may do: entity operations, actions, queries, use cases, pages, each with verdict and deciding policies
simulator.risks('sales.Discount');             // invariants that read a field the action changes, also through derived fields
simulator.run('sales.Cancel', { status: 'draft' }, { actor: 'sales.Staff' }, { reason: 'late' });
```

An action is allowed when its own policies, the `update` policies of its entity and the `create` policies of every entity it creates hold. Nothing is open by default: a target that no policy guards is `no` for every actor. `access` adds policies up along the reference path the same way: a query needs its entity's `read` policies, a use case everything its steps call, a page what its lists and projections show. Expressions are evaluated with three valued logic: anything that needs data that is not given is `UNKNOWN`, which `&&` and `||` short circuit around. `run` checks the policies and preconditions, takes the transition whose state and guard match, applies the effects, records emitted events and reports violated invariants.

## Relevance

`relevance(graph)` scores every module and top level declaration from 0 to 1 by how much it matters to the application (`import { relevance } from '@appling/model'`, or `@appling/model/relevance` without the language dependencies). The score counts the declarations that use it and those it uses, on a log scale against the busiest one; a declared level (`core`, `supporting`, `peripheral`), its own or its module's, maps it into the ranges 0.7 to 1, 0.35 to 0.7 and 0 to 0.35. A module scores as its best declaration. `relevanceLevel(score)` names the level of a score.

## License

MIT

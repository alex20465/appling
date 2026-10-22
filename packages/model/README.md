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
| `applyEdit(sources, operation)` | Applies one edit operation to sources keyed by URI |
| `Graph`, `GraphNode`, `GraphEdge`, `Dependency` | The serializable graph types |

### Nodes

| Field | Meaning |
|---|---|
| `qn` | Qualified name, such as `sales.Order.status` |
| `kind` | The AST type, such as `Field` |
| `layer` | `cross`, `domain`, `behavior`, `application`, `interface` or `experience` |
| `level` | Zoom level: `out` for modules and use cases, `medium` for other top level declarations, `in` for nested elements |
| `module` | Qualified name of the owning module |
| `props` | Scalar properties, plus nested non element parts (types, expressions, preconditions, steps) as canonical text |

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

The touched element is printed canonically, so a formatted file stays formatted. An edit is rejected when it does not parse or when validation reports an error that was not there before.

## License

MIT

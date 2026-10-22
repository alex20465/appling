# @appling/model

The semantic graph of an Appling model: every element as a node, every reference as an edge, and the module dependencies computed from them. Visualization, AI and code generation all read this graph.

## API

```ts
import { buildGraph, dependencies } from '@appling/model';

const graph = buildGraph(models); // resolved Model roots from @appling/lang
const deps = dependencies(graph);
```

| Export | Purpose |
|---|---|
| `buildGraph(models)` | Nodes and edges of resolved models, in document order |
| `dependencies(graph)` | Module to module dependencies with the number of references behind each |
| `isElement(node)` | Whether an AST node becomes a graph node |
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

`contains` links an element to its children. Every other edge is a reference, named after the referencing property: `type`, `entity`, `action`, `event`, `target`, `projection` and so on.

## License

MIT

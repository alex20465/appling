---
title: Semantic graph
description: "The JSON that appling graph prints: nodes, edges and module dependencies, with every field, node kind and edge kind."
---

The semantic graph is the model as data. Every element becomes a node identified by its qualified name, every reference becomes an edge, and module dependencies are computed from the edges. The IDE draws it, the AI tools query it, code generation extensions read it and releases store it. `appling graph` prints it as JSON; in code, `buildGraph` from `@appling/model` builds it (see [API](api.md)).

## Example

This model has two modules, a cross module reference and an invariant:

```appling graph
module crm {
  export Account

  entity Account {
    name: String
  }
}

module sales {
  enum OrderStatus {
    draft
    placed
  }

  entity Order {
    customer: crm.Account
    status: OrderStatus state default draft
    total: Money

    invariant "total never negative" { total >= 0 }
  }
}
```

`appling graph` prints 12 nodes, 14 edges and one dependency. An excerpt:

```json
{
  "nodes": [
    {
      "qn": "sales",
      "kind": "Module",
      "layer": "cross",
      "level": "out",
      "module": "",
      "props": {},
      "data": {}
    },
    {
      "qn": "sales.Order",
      "kind": "Entity",
      "layer": "domain",
      "level": "medium",
      "module": "sales",
      "props": {},
      "data": {}
    },
    {
      "qn": "sales.Order.status",
      "kind": "Field",
      "layer": "domain",
      "level": "in",
      "module": "sales",
      "props": {
        "type": "OrderStatus",
        "modifiers": ["state"],
        "default": "draft"
      },
      "data": {
        "type": { "$type": "TypeRef", "decl": "sales.OrderStatus" },
        "modifiers": ["state"],
        "default": {
          "$type": "NameExpr",
          "name": "draft",
          "type": "OrderStatus",
          "target": "sales.OrderStatus.draft"
        }
      }
    },
    {
      "qn": "sales.Order.invariant[\"total never negative\"]",
      "kind": "Invariant",
      "layer": "domain",
      "level": "in",
      "module": "sales",
      "props": {
        "label": "total never negative",
        "condition": "total >= 0"
      },
      "data": {
        "label": "total never negative",
        "condition": {
          "$type": "BinaryExpr",
          "left": { "$type": "NameExpr", "name": "total", "type": "Money", "target": "sales.Order.total" },
          "op": ">=",
          "right": { "$type": "NumberExpr", "value": 0, "type": "Int" },
          "type": "Bool"
        }
      }
    }
  ],
  "edges": [
    { "from": "sales", "to": "sales.Order", "kind": "contains" },
    { "from": "sales.Order", "to": "sales.Order.status", "kind": "contains" },
    { "from": "sales.Order.customer", "to": "crm.Account", "kind": "type" },
    { "from": "sales.Order.status", "to": "sales.OrderStatus", "kind": "type" },
    { "from": "sales.Order.status", "to": "sales.OrderStatus.draft", "kind": "uses" },
    { "from": "sales.Order.invariant[\"total never negative\"]", "to": "sales.Order.total", "kind": "uses" }
  ],
  "dependencies": [
    { "from": "sales", "to": "crm", "count": 1 }
  ]
}
```

## Top level

| Key | Content |
|---|---|
| `nodes` | Every element, in document order (files in the order they were loaded, each element before its members) |
| `edges` | For each element in node order its `contains` edges and references, then all `uses` edges; each edge appears once |
| `dependencies` | Module to module dependencies. Only `appling graph` adds this key; releases and `buildGraph` hold `nodes` and `edges` only |

## Nodes

| Field | Meaning |
|---|---|
| `qn` | The qualified name: the module path, then the names down to the element, such as `sales.Order.status`. Nested modules give `a.b.X` |
| `kind` | The AST type, such as `Entity`, `Field` or `Transition` |
| `layer` | `cross`, `domain`, `behavior`, `application`, `interface` or `experience` |
| `level` | The zoom level the element belongs to: `out`, `medium` or `in` |
| `module` | The qualified name of the module that owns the element; for a module, its parent module, or `""` at the top |
| `props` | Properties for display |
| `data` | The same properties for tools |

### Layer

A module is `cross`. A top level declaration gets the layer of its keyword:

| Layer | Kinds |
|---|---|
| `cross` | `Module`, `Role`, `Actor`, `Tenant`, `Migration` |
| `domain` | `Enum`, `ValueType`, `Entity` |
| `behavior` | `Event`, `Action`, `Machine`, `Job` |
| `application` | `Query`, `Projection`, `External`, `UseCase` |
| `interface` | `Interface` |
| `experience` | `Page`, `Navigation`, `Flow`, `Messages` |

A nested element takes the layer of the declaration that contains it: a field of an entity is `domain`, a parameter of an action is `behavior`.

### Level

| Level | Nodes |
|---|---|
| `out` | Modules and use cases |
| `medium` | Every other top level declaration |
| `in` | Nested elements, such as fields, enum values, transitions and endpoints |

### props and data

Both hold the element's own properties, without its name and without the elements nested in it (those are nodes of their own, linked by `contains`). Properties that are empty, `false` or missing are left out.

| | `props` | `data` |
|---|---|---|
| Purpose | Display, such as the IDE inspector and the graph rows | Tools, such as code generation extensions and AI |
| Scalars (`label`, `modifiers`, `kind`, `verb`, `path`) | As they are | As they are |
| Nested parts that are not elements (types, expressions, preconditions, steps, sorts) | Canonical source text, such as `"total >= 0"` | Objects with `$type` and their own properties |
| References | Left out, they become edges | The qualified name of the target, or `null` when it does not resolve |
| Expressions | Source text | [ExprData](#exprdata) with the computed `type` and, for names, the `target` |

So an action's precondition shows as `"requires { lines.size() > 0 } else EmptyOrder"` in `props` and as `{ "$type": "Precondition", "condition": { ... }, "error": "sales.PlaceOrder.EmptyOrder" }` in `data`.

## Node kinds

Only some AST types become nodes. All other AST nodes fold into the `props` and `data` of the nearest element that contains them, and their references become edges of that element.

Named elements:

| Kind | Declared by |
|---|---|
| `Module` | `module` |
| `Role`, `Actor`, `Tenant` | `role`, `actor`, `tenant` |
| `Enum`, `EnumLiteral` | `enum` and its values |
| `ValueType` | `value` |
| `Entity`, `Field` | `entity` and the fields of entities, value types, events and actors |
| `Event` | `event` |
| `Action`, `Param`, `ErrorDecl` | `action`, its inputs (and the parameters of use cases and external operations), and declared errors |
| `Machine`, `Job` | `machine`, `job` |
| `Query` | `query` |
| `Projection`, `ProjectionField` | `projection` and its fields |
| `External`, `ExternalOperation` | `external` and its `op` |
| `UseCase` | `usecase` |
| `Interface` | `interface` |
| `Page`, `Navigation`, `Flow`, `Messages` | `page`, `navigation`, `flow`, `messages` |
| `Migration` | `migration` |

Unnamed elements, which get a key instead of a name:

| Kind | Key | Example |
|---|---|---|
| `Invariant` | `invariant[<label as JSON string>]` | `sales.Order.invariant["total never negative"]` |
| `Policy` | `policy[<operations> fields <fields>]`, each part only when present | `sales.Order.policy[read fields total]`, `sales.Order.policy[create,update,delete]`, `sales.PlaceOrder.policy[]` |
| `Transition` | `transition[<from states>-><to state>]` | `sales.OrderFlow.transition[draft,placed->cancelled]` |
| `Endpoint` | `endpoint[<verb> <path>]` | `sales.PublicApi.endpoint[GET /orders]` |
| `SetEffect` | `effect[set <field>]` | `sales.PlaceOrder.effect[set placed_at]` |
| `CreateEffect` | `effect[create <entity>]` | `sales.PlaceOrder.effect[create Invoice]` |
| `EmitEffect` | `effect[emit <event>]` | `sales.OrderFlow.transition[draft->placed].effect[emit OrderPlaced]` |

Lists keep their separators without spaces, and references in keys are written as in the source. When siblings share a key, the second gets `#2`, the third `#3`, and so on: `policy[read]#2`.

Everything else folds into its element, for example types (`TypeRef`), expressions, preconditions, assignments, sorts, use case steps and handlers, page components (`list`, `detail`, `form`), navigation items, messages and migration steps.

## Edges

| Kind | Meaning |
|---|---|
| `contains` | From an element to each element directly inside it, looking through parts that are not elements |
| `uses` | From an element to what a name in one of its expressions stands for: a field, an enum value, a parameter, a role and so on |
| any other | A reference, named after the referencing property |

The reference kinds, with the element the edge starts from:

| Kind | From | To |
|---|---|---|
| `type` | A field, a parameter, or an external operation (its return type) | The enum, value type or entity |
| `entity` | An action, query or tenant; a `create` effect | The entity |
| `field` | A machine; a `set` effect; a query (its sort fields) | The field |
| `fields` | A field policy | The fields it covers |
| `roles` | An actor | Its roles |
| `error` | An action (its preconditions); a use case (its error handlers) | The error |
| `event` | A transition or job; an `emit` effect; a use case (its `await` steps) | The event |
| `action` | A transition or job | The action it runs |
| `actions` | A page (its `list` and `detail` components) | The actions offered |
| `target` | A use case (its calls); an endpoint | The action, query, use case or external operation |
| `source` | A projection | Its entity or query |
| `projection` | An endpoint; a page (its components) | The projection |
| `picks` | An endpoint; a page (its components) | The picked projection fields |
| `query` | A page (its `list` components) | The query |
| `submits` | A page (its `form` components) | The action or use case |
| `page` | A navigation (its items) | The page |
| `pages` | A flow | Its pages |
| `usecase` | A flow | Its use case |

References made by parts that are not elements (preconditions, sorts, steps, components, navigation items) belong to the element that contains them. An edge appears once per element, target and kind, however often the reference repeats.

## Dependencies

`dependencies` aggregates every edge except `contains` whose ends lie in different modules:

| Field | Meaning |
|---|---|
| `from` | The module that references |
| `to` | The module it references |
| `count` | The number of edges behind the dependency |

The IDE draws these at the Modules zoom level, labeled with the count.

## ExprData

An expression inside `data`:

| Field | Meaning |
|---|---|
| `$type` | `BinaryExpr`, `UnaryExpr`, `NameExpr`, `MemberExpr`, `IndexExpr`, `ListExpr`, `StringExpr`, `NumberExpr`, `BoolExpr` or `NullExpr` |
| `type` | The computed type, written as in Appling: `Bool`, `Money`, `OrderStatus`, `Line[]` |
| `target` | For names and members: the qualified name of the element it stands for, such as `sales.Order.total` |
| `op`, `left`, `right` | `BinaryExpr`: operator and operands |
| `op`, `operand` | `UnaryExpr`: `!` or `-` and its operand |
| `name`, `call`, `args` | `NameExpr`: the name; `call` and `args` for builtin calls such as `duration("1h")` |
| `receiver`, `member`, `call`, `args` | `MemberExpr`: `lines.size()` has the receiver `lines`, the member `size` and `call: true` |
| `receiver`, `index` | `IndexExpr` |
| `items` | `ListExpr` |
| `value` | `StringExpr`, `NumberExpr`, `BoolExpr` |

See [Expressions](../language/expressions.md) for the language itself.

## TypeData

A type inside `data`, such as a field's `type`:

| Field | Meaning |
|---|---|
| `$type` | `TypeRef` |
| `primitive` | A built in type: `String`, `Text`, `Int`, `Decimal`, `Bool`, `Date`, `DateTime`, `Duration`, `Money`, `File`, `Uuid` |
| `decl` | Instead of `primitive`: the qualified name of an enum, value type or entity |
| `many` | `true` for a list, `Line[]` |
| `optional` | `true` for an optional type, `DateTime?` |

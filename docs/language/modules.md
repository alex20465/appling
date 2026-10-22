---
title: Modules
description: Modules group declarations into bounded contexts, and exports decide what other modules may reference.
---

A module is a bounded context: a named group of declarations. Every declaration belongs to exactly one module, modules can nest, and the module hierarchy is what the IDE uses to zoom in and out of a model. A module keeps its declarations private unless it lists them in `export`.

## Declaring a module

```appling check
module sales {
  export Order

  enum OrderStatus {
    draft
    placed
  }

  entity Order {
    reference: String unique
    status: OrderStatus default draft
  }
}
```

A module contains any mix of declarations from every layer, plus `export` lines and nested modules. The qualified name of the module is its path: `sales` here.

## Exports

`export` lists the direct members of the module that other modules may reference. A module can have several `export` lines; the names add up.

```appling
export Order, OrderSummary, OpenOrders
export PlaceOrder
```

- Each name must be a declaration directly inside the module. Exporting a name that does not exist is an error: `Module sales has no member "Missing" to export.`
- Exporting a declaration also exports everything inside it, by dotted path. Exporting `Order` makes `sales.Order` and `sales.Order.status` visible to other modules, which lets another module define a field of type `sales.Order` or a machine on `sales.Order.status`.
- Exports are explicit. Nothing becomes visible to other modules just because it exists.

## References across modules

Another module references an exported declaration by its module path, followed by the dotted path inside the module: `crm.Account`, `crm.Clerk`, `sales.Order.status`.

This works across files too. All files of a workspace load together, so `sales.appling` can reference `crm.Account` declared in `crm.appling`. Two modules may reference each other; only the layer rules apply, not an order between modules.

```appling graph
module crm {
  export Account, Clerk

  role Clerk

  entity Account {
    name: String unique
    last_order: sales.Order?
  }
}

module sales {
  export Order

  entity Order {
    reference: String unique
    customer: crm.Account
    policy read { actor.is(crm.Clerk) }
  }
}
```

`appling graph` aggregates these edges into module to module dependencies. For the model above, `sales` depends on `crm` (the `customer` field type and the role in the policy) and `crm` depends on `sales` (the `last_order` field type).

## Nested modules

A module can contain modules. The path of a nested module joins the names with dots: module `b` inside module `a` is `a.b`, and its declaration `X` is `a.b.X`.

```appling check
module a {
  export Report

  entity Report {
    title: String
  }

  module b {
    export Draft

    entity Draft {
      report: Report
    }
  }

  entity Archive {
    draft: a.b.Draft
  }
}
```

- Inside a nested module, the declarations of the enclosing modules are visible by their plain name (`Report` above).
- The enclosing module sees the nested module's declarations only through its exports, by full path (`a.b.Draft`). The relative path `b.Draft` does not resolve.
- What a nested module exports is visible to every module by its full path, whether or not the parent exports the nested module.
- When a parent exports a nested module by name (`export b`), everything inside that nested module becomes visible by path, including declarations the nested module does not export itself.

## Visibility rules

The scope provider resolves a reference written in a module like this:

| Where the target is | How you write it | Needs an export |
|---|---|---|
| Same module | Plain name: `Order` | No |
| Inside a declaration of the same module | Dotted path: `Order.status` | No |
| An enclosing module | Plain name: `Report` | No |
| Another module, any file | Module path: `crm.Account`, `sales.Order.status`, `a.b.Draft` | Yes |

A module cannot reference its own unexported declarations by their full path: inside `sales`, write `Order`, not `sales.Order`. Exported declarations resolve by their full path everywhere, including inside their own module.

Two `module` blocks with the same name are separate scopes: their declarations do not see each other without an export. Keep each module in one block.

Some positions look up names locally instead of through the module scope:

| Position | Resolves against |
|---|---|
| `picks` of an endpoint, `list` or `detail` (`{ reference, status }`) | The fields of the projection after `as` (or of the `detail` projection) |
| `sort` in a query | The fields of the query's entity |
| `set` in an effect | The fields of the action's entity, or of the machine's entity inside a transition |
| `on <Error> do` in a use case step | The errors declared by the called action or external operation |
| `else <Error>` after `requires` | The errors declared by the same action |
| `policy ... fields` | The fields of the entity that holds the policy |

Names inside expressions are not references. They resolve by their position, as described in [expressions](expressions.md). Two of them reach across modules:

- `actor.is(crm.Clerk)` looks the role or actor up with the same rules as a reference, so a role from another module must be exported.
- `actor.<field>` reads a field declared by any actor in the workspace, and `tenant` stands for the entity of the single tenant in the workspace. Neither needs an export.

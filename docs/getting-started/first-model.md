---
title: Your first model
description: Write a small shop model step by step, check it, format it, look at its graph and open it in the IDE.
---

This tutorial builds a small shop: products, orders, a way to place an order and an API that lists placed orders. It touches four of the five layers and every CLI command you need day to day. You need [the CLI](installation.md#the-cli).

## 1. Start with the domain

Create a folder `models` and a file `models/shop.appling`:

```appling check
module shop {
  entity Product {
    name: String unique
    price: Money
  }
}
```

Every declaration lives in a `module`. An `entity` is something your application stores; its fields have a name and a type, and modifiers such as `unique` add rules. Check it:

```sh
npx appling check models
```

```
1 file(s), 0 error(s)
```

## 2. Add orders and their lifecycle

An order references a product, has a quantity and moves through states. Replace the file with:

```appling graph
module shop {
  export Order

  enum OrderStatus {
    draft
    placed
    cancelled
  }

  entity Product {
    name: String unique
    price: Money
  }

  entity Order {
    product: Product
    quantity: Int
    status: OrderStatus state default draft

    invariant "quantity is positive" { quantity > 0 }
  }

  action PlaceOrder on Order {
    requires { product.price > 0 } else FreeProduct
    errors FreeProduct
  }

  action CancelOrder on Order {
    input {
      reason: String?
    }
  }

  machine OrderFlow on Order.status {
    transition draft -> placed via PlaceOrder
    transition draft, placed -> cancelled via CancelOrder
  }
}
```

What is new:

- `enum OrderStatus` lists the possible states, and `status` is marked `state`, so only a state machine may change it.
- The `invariant` is a rule that must hold for every stored order. The condition in braces is a typed expression.
- `PlaceOrder` and `CancelOrder` are actions (layer 2). `requires` is a precondition with the error it raises; `input` declares parameters, `?` makes one optional.
- `OrderFlow` owns the transitions of `Order.status` and says which action triggers each one.
- `export Order` makes the entity visible to other modules as `shop.Order`.

The graph above is what Appling builds from the text: declarations colored by layer, references as arrows. Behavior points down to the domain, never the other way around.

## 3. Let the checker catch a mistake

Change the first transition to `draft -> shipped` and run `check` again:

```
models/shop.appling:35:5 error "shipped" is not a value of OrderStatus.
1 file(s), 1 error(s)
```

The exit code is 1, so the same command guards your CI. Change it back.

## 4. Expose it

Add a query, a projection and a REST interface inside the module:

```appling
  query PlacedOrders from Order {
    where { status == placed }
    paginate 20
  }

  projection OrderSummary from Order {
    quantity
    status
    product_name = product.name
  }

  interface rest ShopApi {
    GET "/orders" -> PlacedOrders as OrderSummary
    POST "/orders/{id}/place" -> PlaceOrder
  }
```

A `query` is filtered, sorted and paginated access to an entity (layer 3). A `projection` is the shape other layers see: the only place where that shape may differ from the entity, here with a field copied from the product. The `interface` (layer 4) maps endpoints to queries and actions, and reaches entity data only through the projection.

> [!TIP]
> Try `GET "/orders" -> Order` instead. The checker rejects it: interfaces reach data through queries and projections, not entities.

## 5. Format and inspect

Write the canonical form back to the file. Running it twice changes nothing:

```sh
npx appling fmt models
```

Print the semantic graph as JSON, the same graph the IDE, the AI and the generators read:

```sh
npx appling graph models
```

Each element is a node with its qualified name, such as `shop.Order.status`, and each reference an edge. See [the semantic graph](../reference/graph.md).

## 6. Open the IDE

```sh
npx @appling/ide models
```

Open `http://127.0.0.1:4410`. The editor and the graph stay in sync: move the cursor to `PlaceOrder` and the graph selects it; rename a field in the inspector and every reference follows. See [the IDE](../tools/ide.md).

## Next steps

- Learn every construct in the [language overview](../language/overview.md), starting with the [domain layer](../language/domain.md).
- Split the model into modules that reference each other: [modules and exports](../language/modules.md).
- Generate a draft [Django](../codegen/django.md) or [Ash](../codegen/ash.md) project from it.

---
title: Experience layer
description: L5 describes what people see, with pages, lists, details, forms, navigation, flows and messages.
---

The experience layer (L5) describes what humans see and interact with: pages with their routes, the lists, detail views and forms on them, the navigation between them, user facing workflows and localized messages. Like [interfaces](interfaces.md), pages reach entity data only through [projections](application.md#projections), and they never reference interfaces. Its keywords are `page`, `navigation`, `flow` and `messages`.

## Pages

A page has a name, a route and a list of components.

```appling
page Orders route "/orders" {
  list OpenOrders as OrderSummary { reference, status, total } actions Cancel
}

page OrderDetail route "/orders/{id}" {
  detail OrderSummary actions PlaceOrder, Cancel
  form Cancel
}
```

The route is a string. Pages own the web routes for people; [interfaces](interfaces.md) own the routes for programs.

### Components

| Component | Form | Shows |
|---|---|---|
| `list` | `list Query as Projection { picks } actions A, B` | The results of a query, shaped by a projection |
| `detail` | `detail Projection { picks } actions A, B` | One record, shaped by a projection |
| `form` | `form Target` | A form that submits an action or a use case |

- `as Projection` is required on a list: a list shows query results only through a projection.
- `{ picks }` selects some fields of the projection, separated by commas. Without picks, the component shows all of them. Picks resolve against the projection's fields, computed ones included.
- `actions A, B` adds the actions a person can run from the list or the detail view.

## Navigation

A navigation is a menu: labeled entries that lead to pages. An entry can hold nested entries in braces.

```appling
navigation Main {
  "Orders" -> Orders {
    "Open" -> Orders
    "Detail" -> OrderDetail
  }
}
```

## Flows

A flow is a user facing workflow over a [use case](application.md#use-cases): the pages a person goes through, in order. It references the use case and does not redefine its process logic.

```appling
flow CheckoutFlow for Checkout { Orders -> OrderDetail }
```

## Messages

A messages block holds localized labels and texts. Its name is usually the locale, and each entry maps a key to a string.

```appling
messages en {
  OrderSummary.total = "Total"
  Orders = "Your orders"
}
```

A key is a dotted name, by convention the path of the element it labels inside the module, such as `OrderSummary.total`. Keys are not checked as references, but renaming an element through the [edit operations](../reference/edit-operations.md) also renames the message keys that start with its path.

## What a page may reference

Queries, projections and use cases from L3, actions from L2, enums and value types from L1, and cross cutting declarations, plus other experience declarations. A page never references an entity or an interface. See [reference rules](overview.md#reference-rules).

## Complete example

```appling check
module sales {
  enum OrderStatus {
    draft
    placed
  }

  entity Order {
    reference: String unique
    status: OrderStatus state default draft
    total: Money
  }

  action PlaceOrder on Order {
  }

  action Cancel on Order {
    input {
      reason: String?
    }
  }

  query OpenOrders from Order {
    where { status == placed }
  }

  projection OrderSummary from Order {
    reference
    status
    total
  }

  usecase Checkout (order: Order) {
    step PlaceOrder(order)
  }

  page Orders route "/orders" {
    list OpenOrders as OrderSummary { reference, status, total } actions Cancel
  }

  page OrderDetail route "/orders/{id}" {
    detail OrderSummary actions PlaceOrder, Cancel
    form Cancel
  }

  page Pay route "/checkout" {
    form Checkout
  }

  navigation Main {
    "Orders" -> Orders {
      "Checkout" -> Pay
    }
  }

  flow CheckoutFlow for Checkout { Orders -> OrderDetail -> Pay }

  messages en {
    OrderSummary.total = "Total"
  }
}
```

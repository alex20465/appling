---
title: Application layer
description: L3 organizes domain capabilities for use, with queries, projections, external systems and use cases.
---

The application layer (L3) describes how domain capabilities are organized for practical use. Its declarations may reference the [domain](domain.md) and [behavior](behavior.md) layers. Interfaces and pages reach the data through this layer. Its keywords are `query`, `projection`, `external` and `usecase`.

## Queries

A query is filtered, sorted and paginated access to one entity.

```appling
query OpenOrders from Order {
  where { status in [placed, paid] }
  sort placed_at desc
  paginate 50
}
```

| Clause | Meaning |
|---|---|
| `from Entity` | The entity the query reads |
| `where { condition }` | A Bool filter over the entity's fields; it can also read `this`, `actor`, `now` and `tenant` |
| `sort a desc, b` | Sort fields of the entity, each with an optional `asc` or `desc` (the generators default to ascending) |
| `paginate N` | The page size |
| `policy { condition }` | Query level access policies, any number |

All clauses are optional and come in this order. A query inherits the policies of its entity; its own policies can only narrow access further. See [access](access.md#narrowing).

A use case calls a query without arguments: `step OpenOrders()`.

## Projections

A projection is a shaped read model over an entity or a query. It is the only place where a shape may diverge from the entity, for example for an API version or a page. [Interfaces](interfaces.md) and [pages](experience.md) reach entity data only through projections.

```appling
projection OrderSummary from Order {
  reference
  status
  total
  customer_name = customer.name
}
```

A projection lists its fields, one per line:

| Field | Meaning |
|---|---|
| `reference` | A picked field: a field of the source entity, shown as it is |
| `customer_name = customer.name` | A computed field: an expression over the source entity's fields |

A projection `from` a query uses the fields of the query's entity. A picked field that the entity does not have is an error that suggests the computed form: `Order has no field "missing". Use "missing = <expression>" for a computed field.`

Projection fields are elements of their own (`sales.OrderSummary.customer_name`), and endpoints and pages can pick from them.

## External systems

An external system is an integration the application consumes, declared with typed operations.

```appling
external Payments {
  op Charge (amount: Money) returns String errors Declined
  op Refund (charge: String, amount: Money?)
}
```

| Part | Meaning |
|---|---|
| `op Name (params)` | An operation with typed parameters; optional parameters end in `?` |
| `returns Type` | The result type, optional |
| `errors A, B` | The errors the operation can raise, optional |

A use case calls an operation by its path: `Payments.Charge(order.total)`.

## Use cases

A use case is the single process concept: it orchestrates actions, queries, external operations and events into one application level operation, which may run for a long time.

```appling
usecase Checkout (order: Order) {
  step PlaceOrder(order)
  step Payments.Charge(order.total) on Declined do Cancel(order)
  await PaymentReceived timeout "24h" do Cancel(order)
}
```

A use case has optional parameters in parentheses, followed by steps and policies in any order.

### Steps

`step Target(args)` calls an action, a query, another use case or an external operation. The arguments are expressions that can read the use case's parameters, `actor`, `now` and `tenant`.

The arguments must match the target:

| Target | Arguments |
|---|---|
| Action on an entity | The entity, then the inputs in order |
| Action without an entity | The inputs in order |
| External operation | Its parameters in order |
| Use case | Its parameters in order |
| Query | None |

Optional inputs and parameters may be left out. A wrong count is reported as `Close takes 1 to 2 argument(s), got 0.`, a wrong type as `Int is not assignable to String?.`

### Error handlers

`on Error do Call(...)` after a step handles an error that the called action or external operation declares. A step can have several handlers:

```appling
step Payments.Charge(order.total) on Declined do Cancel(order) on Timeout do Retry(order)
```

The error name resolves only against the errors of the called target.

### Awaiting events

`await Event` waits until the event happens. `timeout "<duration>" do Call(...)` adds what to do when the event does not arrive in time.

```appling
await PaymentReceived timeout "24h" do Cancel(order)
```

### Policies

`policy { condition }` guards the use case. The condition reads the use case's parameters, `actor`, `now` and `tenant`. Operations and `fields` are not allowed here.

## Complete example

```appling check
module sales {
  enum OrderStatus {
    draft
    placed
    paid
    cancelled
  }

  entity Customer {
    name: String
  }

  entity Order {
    reference: String unique
    customer: Customer
    status: OrderStatus state default draft
    total: Money
    placed_at: DateTime?
  }

  event PaymentReceived {
    order: Order
  }

  action PlaceOrder on Order {
  }

  action Cancel on Order {
    input {
      reason: String?
    }
  }

  query OpenOrders from Order {
    where { status in [placed, paid] }
    sort placed_at desc
    paginate 50
  }

  projection OrderSummary from OpenOrders {
    reference
    status
    total
    customer_name = customer.name
  }

  external Payments {
    op Charge (amount: Money) returns String errors Declined
  }

  usecase Checkout (order: Order) {
    step PlaceOrder(order)
    step Payments.Charge(order.total) on Declined do Cancel(order, "declined")
    await PaymentReceived timeout "24h" do Cancel(order)
    policy { actor.is(Shopper) }
  }

  actor human Shopper
}
```

---
title: Interfaces layer
description: L4 exposes queries, actions and use cases to programs through interfaces with endpoints.
---

The interfaces layer (L4) describes how application capabilities are exposed to programs: REST APIs, GraphQL schemas, MCP servers, webhooks or any other protocol. An interface maps endpoints to queries, actions and use cases, and adds transport restrictions. Web routes for pages people visit belong to the [experience layer](experience.md), not here.

## Declaring an interface

```appling
interface rest PublicApi {
  auth bearer
  limit 100 per minute
  cors "https://shop.example.com"
  GET "/orders" -> OpenOrders as OrderSummary { reference, status, total }
  POST "/orders/{id}/place" -> PlaceOrder
}
```

`interface <protocol> <Name>` starts the declaration. The protocol is any identifier you choose, such as `rest`, `graphql` or `mcp`; the language does not restrict it. The [Django](../codegen/django.md) and [Ash](../codegen/ash.md) generators generate code for `rest` interfaces.

The clauses come in this order, each optional:

| Clause | Meaning | Example |
|---|---|---|
| `auth <scheme>` | The authentication scheme, any identifier | `auth bearer`, `auth apikey` |
| `limit <n> per <unit>` | A rate limit; the unit is `second`, `minute` or `hour` | `limit 100 per minute` |
| `cors "<origin>", ...` | Allowed CORS origins | `cors "https://a.example", "https://b.example"` |
| Endpoints | One per line | `GET "/orders" -> OpenOrders as OrderSummary` |

These transport policies only add restrictions. They never widen what the policies of the queries, actions, use cases and entities allow. See [access](access.md#narrowing).

## Endpoints

```text
<VERB> "<path>" -> <Target> as <Projection> { <picks> }
```

| Part | Meaning |
|---|---|
| Verb | Any identifier, by convention an HTTP method such as `GET`, `POST`, `PUT`, `PATCH`, `DELETE` |
| Path | A string, such as `"/orders/{id}/place"` |
| Target | A query, an action or a use case |
| `as Projection` | The projection that shapes the data, optional except for queries |
| `{ picks }` | Some fields of that projection, separated by commas; without picks, all of them |

An endpoint is identified by its verb and path: `sales.PublicApi.endpoint[GET /orders]`.

### Data only through projections

An interface never references an entity. It reaches entity data only through a [projection](application.md#projections), so the shape it exposes is declared once in the application layer and can only narrow the entity.

An endpoint that targets a query must name a projection: `An endpoint exposes query results only through a projection: add "as <Projection>".`

Picks resolve against the fields of the projection after `as`, including its computed fields.

### What an interface may reference

Queries, projections and use cases from L3, actions from L2, enums and value types from L1, and cross cutting declarations. Any other reference is a layer error; in particular an interface never references a page. See [reference rules](overview.md#reference-rules).

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

  query OpenOrders from Order {
    where { status == placed }
  }

  projection OrderSummary from Order {
    reference
    status
    total
    label = reference + " " + "order"
  }

  usecase Checkout (order: Order) {
    step PlaceOrder(order)
  }

  interface rest PublicApi {
    auth bearer
    limit 100 per minute
    cors "https://shop.example.com"
    GET "/orders" -> OpenOrders as OrderSummary { reference, status, label }
    POST "/orders/{id}/place" -> PlaceOrder
    POST "/checkout" -> Checkout
  }

  interface mcp Assistant {
    auth apikey
    GET "/orders" -> OpenOrders as OrderSummary
  }
}
```

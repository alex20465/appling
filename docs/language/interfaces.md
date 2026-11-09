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
| `auth <scheme>` | The authentication scheme, any identifier, optionally with the [external](application.md#settings-and-secrets) that provides it | `auth bearer`, `auth apikey`, `auth bearer from Clerk` |
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

### Query inputs

An endpoint that targets a query with [inputs](application.md#queries) takes them from the request. A `{name}` in the path names an input; every other input comes from the query string, a list input from repeated parameters.

```appling
GET "/accounts/{of}/orders" -> OrdersOf as OrderSummary { reference, status, total }
```

`GET /accounts/7/orders?since=2026-10-01T00:00:00Z` passes the account 7 as `of` and the time as `since`; without `since` it is null. An input that names an entity takes the record's id.

Two rules keep the mapping sound:

- Every path parameter names an input of the query: `Path parameter {id} is not an input of query OpenOrders.`
- Every input has a type a URL can carry: a primitive other than `File`, an enum, an entity or a list of those. A value type or a file is an error: `Input range of query Q has the type Range, which a URL cannot carry.`

## Vendors

An interface can name the [external](application.md#settings-and-secrets) a vendor stands behind, in two places:

| Where | Meaning | Example |
|---|---|---|
| `auth <scheme> from <External>` | The vendor signs the users in, such as an identity provider | `auth bearer from Clerk` |
| `interface <protocol> <Name> from <External>` | The vendor calls these endpoints, such as webhooks | `interface webhook ClerkEvents from Clerk` |

A `webhook` interface must name its vendor: `A webhook interface names its vendor: "interface webhook ClerkEvents from <External>".` A webhook interface without endpoints gets a warning: `Webhook interface ClerkEvents has no endpoints.` For other protocols `from` is optional.

```appling check
module accounts {
  entity Account {
    email: String
  }

  action SyncAccount on Account {
  }

  external Clerk {
    secret secret_key: String does "API keys page of the Clerk dashboard"
    secret webhook_secret: String
  }

  interface rest Api {
    auth bearer from Clerk
  }

  interface webhook ClerkEvents from Clerk {
    POST "/webhooks/clerk" -> SyncAccount
  }
}
```

### What an interface may reference

Queries, projections, externals and use cases from L3, actions from L2, enums and value types from L1, and cross cutting declarations. Any other reference is a layer error; in particular an interface never references a page. See [reference rules](overview.md#reference-rules).

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

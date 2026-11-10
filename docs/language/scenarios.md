---
title: Scenarios
description: "Examples of behavior: given rows, as an actor, when one call, then what holds. appling check runs them in the simulator and every code generator turns them into tests."
---

A scenario is one concrete case of what the model does: given some rows, when an actor calls an action or a use case, then something holds, the call fails, or a policy refuses it. `appling check` runs every scenario in the [simulator](../tools/simulator.md), and every code generator writes it as a test. A scenario is a module member outside the five layers and may reference anything its module sees.

```appling check
module sales {
  role Customer
  actor human Shopper roles Customer {
    name: String
  }

  enum OrderStatus {
    draft
    placed
  }

  entity Order {
    owner: String
    status: OrderStatus state default draft
    items: Int default 0
    policy update { actor.is(Customer) && owner == actor.name }
  }

  event OrderPlaced {
    order: Order
  }

  action PlaceOrder on Order {
    requires { items > 0 } else EmptyOrder
    errors EmptyOrder
    policy { actor.is(Customer) }
  }

  machine OrderFlow on Order.status {
    transition draft -> placed via PlaceOrder effect { emit OrderPlaced { order = this } }
  }

  scenario PlaceOwnOrder does "A shopper places their own order" {
    given {
      order = create Order { owner = "ann", items = 2 }
    }
    as Shopper { name = "ann" }
    when PlaceOrder(order)
    then {
      order.status == placed
      emitted OrderPlaced { order = order }
    }
  }

  scenario EmptyOrderIsRefused {
    given {
      order = create Order { owner = "ann" }
    }
    as Shopper { name = "ann" }
    when PlaceOrder(order)
    then fails EmptyOrder
  }

  scenario OnlyOwnOrders {
    given {
      order = create Order { owner = "ann", items = 1 }
    }
    as Shopper { name = "bob" }
    when PlaceOrder(order)
    then refused
  }
}
```

## Syntax

```appling
scenario <Name> [core | supporting | peripheral] [does "..."] {
  given { [<name> =] create <Entity> { <field> = <expression>, ... } ... }
  as <Actor or Role> [{ <field> = <expression>, ... }]
  when <Action or UseCase>(<arguments>)
  then { <checks> } | then fails [<Error>] | then refused
}
```

`given` and `as` are optional. A given row starts with its entity's [defaults](domain.md#fields), empty lists and null optional fields, then takes the given values, which may name rows bound before it. It must satisfy its entity's invariants. Fields left out without a default are unknown to the simulator, so give every field the outcome depends on.

`as` names a declared [actor](access.md#actors), or a role for the first actor holding it; only an actor takes field values. With `as`, the policies along the call are checked as the simulator decides them; without it, the call runs as the system does, unchecked.

`when` takes arguments like a [use case step](application.md#use-cases): an action gets its entity's row first, then its inputs. A use case runs its steps and `on` handlers, assumes externals and queries succeed, and stops at the first `await`.

| `then` | Holds when |
|---|---|
| `{ checks }` | The call runs, breaks no invariant, and every check holds: a `Bool` expression over the rows after the call, or `emitted <Event> [{ field = value }]` |
| `fails <Error>` | The call fails with that error of the action, or of what the use case calls |
| `fails` | The call fails with any error |
| `refused` | A policy refuses the actor |

## How check runs scenarios

Once the model has no other errors, `appling check` reports every failing scenario at its name, one line per reason: a false check, an event not emitted, a call that did not fail or failed differently, a refusal or its absence, a broken invariant, or a value the outcome depends on that the scenario does not give.

```
$ appling check examples
examples/sales.appling:127:12 error Scenario ClerkCancelsDraft fails: order.status == placed is false.
2 file(s), 1 error(s)
```

## Generated tests

Every [code generator](../codegen/overview.md) writes one test per scenario with its rows (samples for required fields left out), actor, call and assertions. The scenario test replaces the guessed precondition and transition tests of what it calls; what a target cannot express stays a skipped test with a [registry](../codegen/registry.md) task. See [Django](../codegen/django.md), [Ash](../codegen/ash.md), [Go](../codegen/go.md) and [Rust](../codegen/rust.md).

## Limits

- A given row cannot set a field of a value type yet.
- `tenant` is unknown inside a scenario.

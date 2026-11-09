---
title: Scenarios
description: "Examples of behavior: given rows, as an actor, when one call, then what holds. appling check runs them in the simulator and every code generator turns them into tests."
---

A scenario is an example of what the model does: given some rows, when an actor calls an action, a use case or an endpoint, then something holds, the call fails with an error, or a policy refuses it. Rules such as invariants, preconditions and policies say what must always be true; a scenario shows one concrete case that someone can read, and the tools check it.

- `appling check` runs every scenario in the [simulator](../tools/simulator.md). A scenario whose `then` does not hold is an error.
- Every code generator writes one real test per scenario, with the same rows, actor, call and assertions. See [generated tests](#generated-tests).

A scenario is a module member outside the five layers. It may reference anything visible in its module: its own declarations and the exports of other modules.

## An example

```appling check
module crm {
  export Account, Clerk

  role Clerk
  actor human Employee roles Clerk

  entity Account {
    name: String unique
    policy read { actor.is(Clerk) }
  }
}

module sales {
  role Customer
  actor human Shopper roles Customer {
    account: crm.Account
  }

  enum OrderStatus {
    draft
    placed
    cancelled
  }

  entity Order {
    reference: String unique
    customer: crm.Account
    status: OrderStatus state default draft
    items: Int default 0
    policy update { actor.is(crm.Clerk) || (actor.is(Customer) && customer == actor.account) }
  }

  event OrderPlaced {
    order: Order
  }

  action PlaceOrder on Order {
    requires { items > 0 } else EmptyOrder
    errors EmptyOrder
    policy { actor.is(Customer) && customer == actor.account }
  }

  action Cancel on Order {
    policy { actor.is(crm.Clerk) }
  }

  machine OrderFlow on Order.status {
    transition draft -> placed via PlaceOrder effect { emit OrderPlaced { order = this } }
    transition draft, placed -> cancelled via Cancel
  }

  interface rest PublicApi {
    POST "/orders/{id}/place" -> PlaceOrder
  }

  scenario PlaceOwnOrder does "A shopper places their own order" {
    given {
      acme = create crm.Account { name = "Acme" }
      order = create Order { reference = "A-1", customer = acme, items = 2 }
    }
    as Shopper { account = acme }
    when PlaceOrder(order)
    then {
      order.status == placed
      emitted OrderPlaced { order = order }
    }
  }

  scenario EmptyOrderIsRefused {
    given {
      acme = create crm.Account { name = "Acme" }
      order = create Order { reference = "A-2", customer = acme }
    }
    as Shopper { account = acme }
    when PublicApi POST "/orders/{id}/place"(order)
    then fails EmptyOrder
  }

  scenario OnlyOwnOrders {
    given {
      acme = create crm.Account { name = "Acme" }
      globex = create crm.Account { name = "Globex" }
      order = create Order { reference = "A-3", customer = acme, items = 1 }
    }
    as Shopper { account = globex }
    when PlaceOrder(order)
    then refused
  }

  scenario ClerkCancels {
    given {
      acme = create crm.Account { name = "Acme" }
      order = create Order { reference = "A-4", customer = acme }
    }
    as crm.Clerk
    when Cancel(order)
    then {
      order.status == cancelled
    }
  }
}
```

## Syntax

```appling
scenario <Name> [core | supporting | peripheral] [does "..."] {
  given {
    <name> = create <Entity> { <field> = <expression>, ... }
    create <Entity> { ... }
  }
  as <Actor or Role> [{ <field> = <expression>, ... }]
  when <call>
  then { <checks> } | then fails [<Error>] | then refused
}
```

The parts come in this order. `given` and `as` are optional; `when` and `then` are required.

### given

`given` lists the rows the scenario starts with. Each `create` makes one row of an entity; `name =` binds it, so later rows, the call and the checks can use it. A row without a name exists but cannot be named.

A row starts with the [defaults](domain.md#fields) of its entity, an empty list for every list field and `null` for every optional field. The values you give replace them. A value is an [expression](expressions.md) that may name the rows bound before it, such as `customer = acme` or `lines = [line]`. Fields you leave out that have no default are unknown to the simulator; the generated tests fill them with sample values. When the outcome depends on such a field, the scenario fails and says so, so give every field the scenario relies on.

A given row must satisfy the invariants of its entity.

### as

`as` names the actor the call runs as: a declared [actor](access.md#actors), or a role, which stands for the first declared actor holding it. After an actor, `{ field = value }` gives its fields, its own and those of the entity it is bound to with `is`. A role has no fields of its own, so name an actor to give them.

Without `as`, the call runs without an actor, the way a system or a job calls it, and policies are not checked. With `as`, the call is checked against the policies along its path, as the [simulator](../tools/simulator.md#how-it-decides) decides them, as long as the model declares any policy.

### when

`when` is exactly one call, with arguments like a [use case step](application.md#use-cases):

| Call | Arguments |
|---|---|
| `when PlaceOrder(order)` | An action: the row of its entity first, then its inputs in order |
| `when Checkout(order)` | A use case: its parameters in order |
| `when PublicApi POST "/orders/{id}/place"(order)` | An endpoint, named by its interface, verb and path: the arguments of the action or use case it exposes |

A use case runs its call steps in order. When a step fails with an error that one of its `on` handlers names, the handler runs instead; otherwise the use case fails with that error. Calls to externals and queries are assumed to succeed, and the run stops at the first `await`, since what follows waits for an event.

### then

`then` says how the call ends, in one of three forms:

| Form | Holds when |
|---|---|
| `then { checks }` | The call runs, breaks no invariant of the entity, and every check holds |
| `then fails <Error>` | The call fails with that declared error. `<Error>` is one of the errors of the action, or of what the use case's steps call |
| `then fails` | The call fails with any error, such as a precondition without `else` or a state the machine has no transition from |
| `then refused` | A policy refuses the actor |

A check is either a `Bool` [expression](expressions.md) over the bound rows, read after the call, or `emitted <Event>`, which holds when the call emitted that event, optionally with field values: `emitted OrderPlaced { order = order }`.

## How check runs scenarios

`appling check` runs the scenarios once the model itself has no errors. A failing scenario is reported as an error at its name, one line per reason:

```
$ appling check examples
examples/sales.appling:127:12 error Scenario ClerkCancelsDraft fails: order.status == placed is false.
2 file(s), 1 error(s)
```

| Reason | Message after `Scenario <Name> fails:` |
|---|---|
| A given row breaks an invariant | `<row> breaks the invariant "<label>" of <Entity>.` |
| A policy refuses the actor | `<Target> was refused: no policy allows the actor.` |
| The call fails | `<Target> failed: <errors or conditions>.` |
| The call breaks an invariant | `<Target> breaks the invariant "<label>".` |
| A check is false | `<check> is false.` |
| An event was not emitted | `<Event> was not emitted.` or `<Event> was emitted, but not with <fields> as given.` |
| `fails` but the call ran | `<Target> did not fail.` |
| `fails <Error>` but another error | `<Target> failed with <errors>, not <Error>.` |
| `refused` but the call was allowed | `<Target> was not refused.` |
| A policy, precondition, guard or check needs a value the scenario does not give | `Whether the actor may call <Target> depends on data the scenario does not give.`, `<Target>: <condition> depends on data the scenario does not give.` or `<check> depends on data the scenario does not give.` |

The [MCP server's](../tools/ai.md) `check` tool reports the same errors.

## Generated tests

Every [code generator](../codegen/overview.md) writes one test per scenario, under the scenario's [registry](../codegen/registry.md) entry: it creates the given rows (filling the required fields the scenario leaves out with samples), runs the call as the actor, and asserts the `then`. A part a target cannot express stays a registry task, as a skipped test.

The tests that a generator guesses from the model, such as the precondition tests of an action and the tests of the transitions it triggers, are replaced by the scenario tests wherever a scenario covers the same action or use case. Each target page says what a scenario becomes there: [Django](../codegen/django.md), [Ash](../codegen/ash.md), [Go](../codegen/go.md), [Rust](../codegen/rust.md).

## In the graph

A scenario is a [graph](../reference/graph.md) node of kind `Scenario`, layer `cross`, with its rows, actor, call and checks in `data`, and one edge per reference: `entity` to each given entity, `persona` to the actor or role, `target` to the called action or use case (`api` for an endpoint), `error` for `fails`, `event` for `emitted`, and `uses` for the fields its expressions read.

## Limits

- A given row cannot set a field of a value type yet; such a field starts empty or at its default.
- External operations and queries called by a use case are not simulated, and the run stops at the first `await`.
- `tenant` is unknown inside a scenario, so a role condition or policy that reads it makes the scenario depend on data it does not give.

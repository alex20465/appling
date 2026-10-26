---
title: Simulator
description: "Ask the model how it behaves: reachable states, who may trigger an action, what one actor may do, which invariants an action puts at risk, and what running an action does."
---

The simulator evaluates the behavior a model describes against sample data and actors, without generating code. It answers five questions:

| Question | Answer |
|---|---|
| Can a machine reach a state? | The shortest path of transitions from the initial state, or that the state is unreachable |
| Which actors may trigger an action? | For every declared actor `yes`, `no`, or `depends` on the data |
| What may one actor do? | For every entity operation, action, query, use case and page the verdict and the policies that decide it |
| Which invariants does an action put at risk? | The invariants of its entity that read a field the action changes, directly or through derived fields |
| What does running an action do? | Policies, preconditions, the transition taken, the effects, emitted events and violated invariants |

You reach it through `appling simulate` in the [CLI](cli.md#simulate), the `simulate` tool of the [MCP server and the IDE chat](ai.md#model-tools), and the [IDE inspector](ide.md#the-inspector), which shows the answers for the selected action or machine.

## An example

```appling check
module shop {
  role Clerk
  role Buyer
  actor human Staff roles Clerk
  actor human Customer roles Buyer {
    name: String
  }

  enum Status {
    open
    closed
  }

  value Line {
    amount: Money
  }

  entity Cart {
    owner: String
    status: Status state default open
    lines: Line[]
    discount: Money default 0
    total: Money = sum(lines.map(l, l.amount)) - discount

    invariant "total not negative" { total >= 0 }
  }

  action Close on Cart {
    requires { lines.size() > 0 } else Empty
    errors Empty
    policy { actor.is(Clerk) || (actor.is(Buyer) && owner == actor.name) }
  }

  action Discount on Cart {
    input {
      amount: Money
    }
    effect {
      set discount = amount
    }
    policy { actor.is(Clerk) }
  }

  machine Flow on Cart.status {
    transition open -> closed via Close
  }
}
```

```
$ appling simulate reach shop.Flow closed
closed is reachable from open:
  Close -> closed

$ appling simulate actors shop.Close
shop.Staff: yes
shop.Customer: depends on the data

$ appling simulate actors shop.Discount
shop.Staff: yes
shop.Customer: no

$ appling simulate risks shop.Discount
shop.Cart.invariant["total not negative"] (reads discount)
```

A customer may close a cart only when it is theirs, which depends on the cart's `owner`, so the answer for `Customer` is `depends`. `Discount` changes `discount`, which the derived `total` reads, so the invariant on `total` is at risk.

## How it decides

**Reachability.** The search starts at the default of the machine's state field, or at every value of its enum when the field has no default, and follows transitions by their `from` states. Guards are not evaluated; the path marks guarded transitions.

**Who may trigger an action.** An action is allowed when its own policies, the policies of its entity that cover `update` (or every operation), and the policies that cover `create` of every entity it creates (through a `create` effect of the action or of a transition it triggers) hold. Following the [concept](../concept.md), the effective policy is the conjunction of all policies along the way, so an entity that only lets clerks update it also keeps other actors from its actions. An actor holds the roles listed in its declaration, and `actor.is(...)` is true for those roles and for the actor itself.

**What one actor may do.** `access` judges the same way, for one actor and every target, with the policies that add up along the reference path:

| Target | Policies |
|---|---|
| Entity, per operation | The entity's policies that cover the operation and name no fields; a policy with `fields` gives one more entry for those fields, on top of the others |
| Action | Its own, its entity's policies that cover `update`, and the policies that cover `create` of every entity it creates |
| Query | Its own, and its entity's policies that cover `read` |
| Use case | Its own, and those of every action, query, use case and external operation its steps and error handlers call |
| Page | Those of the queries its lists show and of the projections it shows (a projection needs what its source needs). The actions a page offers are judged on their own |

Nothing is open by default: a target that no policy guards along its path is `no` for every actor, with no deciding policy. A role that no policy names may do nothing.

**Unknown data.** Expressions are evaluated with three valued logic. A value that needs data you did not give, such as a field of a record or an actor's field, is unknown. A field the actor does not declare is null, and so is any field read from a null value, such as `actor.desk.closed_at` for an actor without `desk`. `a && b` is false as soon as one side is false, `a || b` is true as soon as one side is true, and everything else that touches an unknown value stays unknown. A policy that comes out unknown makes the verdict `depends`.

**Running an action.** A run checks, in order: the policies (`no` refuses the run), the preconditions (a false one reports its error), the transition whose `from` state matches and whose guard does not fail, then applies the transition's effects, the state change and the action's effects, records `emit` effects as events, and evaluates the entity's invariants on the result. Derived fields are computed from the record when an expression reads them.

## Running an action from the MCP server

The `simulate` tool takes `question: "run"`, the `action`, a sample `record`, the `actor` and optionally `actorFields` and `inputs`:

```json
{ "question": "run", "action": "shop.Discount", "record": { "owner": "ada", "status": "open", "lines": [{ "amount": 5 }], "discount": 0 }, "actor": "shop.Staff", "inputs": { "amount": 20 } }
```

The answer lists `allowed`, `outcome` (`done`, `refused` or `error`), the `reasons` when it did not run, the record `before` and `after`, the `events` and the `violated` invariants, here `["total not negative"]`. Values the simulator could not know appear as `"unknown"`.

## Use it in code

```ts
import { Simulator } from '@appling/model';

const simulator = new Simulator(graph);
simulator.reach('shop.Flow', 'closed');
simulator.actors('shop.Close');
simulator.access('shop.Customer');
simulator.risks('shop.Discount');
simulator.run('shop.Discount', { lines: [{ amount: 5 }], discount: 0 }, { actor: 'shop.Staff' }, { amount: 20 });
```

`@appling/model/simulator` exports the same class without the language dependencies, for the browser. The IDE uses it this way.

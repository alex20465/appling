---
title: Access
description: Roles, actors, tenants and the policies that guard entities, actions, queries and use cases.
---

Access in Appling is declared with three cross cutting concepts (roles, actors and tenants) and with policies placed next to the elements they protect. Every policy is a Bool [expression](expressions.md) that can read the current `actor` and `tenant`.

## Roles

A role is a name that actors carry and policies test.

```appling
role Clerk
role Customer
```

## Actors

An actor is someone or something that acts on the application. It has a kind, a name, optional roles and optional typed fields.

```appling
actor human Shopper roles Customer {
  account: crm.Account
}
actor system Scheduler
actor service PaymentWebhook roles Integration
```

| Part | Meaning |
|---|---|
| `human`, `system`, `service` | The kind of actor: a person, an internal process, an external service |
| `roles A, B` | The roles this actor carries; references to `role` declarations, also from other modules (`roles crm.Clerk`) |
| `{ fields }` | Typed fields, written like [entity fields](domain.md#fields), that expressions read as `actor.<field>` |

In an expression, `actor.account` is valid when at least one actor in the workspace declares `account`. When some actors do not declare it, the value is optional for them, and `actor.account` has an optional type. Actor fields are collected from the whole workspace, so they need no export.

## Tenants

A tenant names the entity that partitions the data, such as the company an account belongs to.

```appling
tenant Company on Account
```

When the workspace declares exactly one tenant, the name `tenant` is available in every expression and has the type of that entity. With no tenant or with several, `tenant` is an unknown name.

## Policies

A policy is a condition in braces, introduced by `policy`. Policies sit on the element they protect:

| Element | Policy form | Names in the condition |
|---|---|---|
| `entity` | `policy [operations] [fields f, g] { condition }` | The entity's fields, `this` |
| `action` | `policy { condition }` | The fields of the action's entity, `this`, the action's inputs |
| `query` | `policy { condition }` | The fields of the query's entity, `this` |
| `usecase` | `policy { condition }` | The use case's parameters |

`actor`, `now` and `tenant` are available in all of them. An element can have any number of policies.

### Granting by role

A policy grants access to roles. Write one `||` branch per role that may act, each starting with `actor.is(Role)` and followed by `&&` and the conditions that role must meet:

```appling
policy { actor.is(Clerk) || (actor.is(Customer) && account == actor.account) }
```

Nothing is open by default. A role that no policy names may do nothing, and a target that no policy guards along its path is closed to every actor. Write `{ false }` to state that nobody may, such as `policy delete { false }` for records that are never deleted. The validator warns about a policy with a branch that names no role, which includes `{ true }` and negative checks such as `!actor.is(Clerk) || ...`: `A policy grants by role: every "||" branch needs actor.is(Role), or write { false }.`

### Operations

On an entity, a policy can name the operations it covers: `read`, `create`, `update`, `delete`, separated by commas. Without operations, it covers every operation.

### Field policies

On an entity, `fields` limits a policy to some of its fields. Combine it with operations to guard reading one field:

```appling
policy read fields total { actor.is(crm.Clerk) || (actor.is(Customer) && status != draft) }
```

Operations and `fields` exist only on entity policies. On an action, a query or a use case, the validator rejects them: `Operations and fields narrow entity policies only.`

### actor.is

`actor.is(X)` is true when the current actor carries role `X`, or is actor `X`. The argument is a role or actor name, written as a plain or dotted name (`Clerk`, `crm.Clerk`) and resolved like a reference, so a role from another module must be exported. Anything else is an error: `"Nobody" is not a role or actor.`

## Example

```appling check
module shop {
  role Clerk
  role Customer

  actor human Shopper roles Customer {
    account: Account
  }
  actor human Employee roles Clerk

  entity Account {
    name: String unique
    policy read { actor.is(Clerk) || (actor.is(Customer) && actor.account == this) }
  }

  tenant Company on Account

  entity Order {
    account: Account
    total: Money
    note: Text?
    policy read { actor.is(Clerk) || (actor.is(Customer) && account == actor.account) }
    policy create, update, delete { actor.is(Clerk) }
    policy read fields note { actor.is(Employee) }
  }

  action Refund on Order {
    input {
      amount: Money
    }
    requires { amount <= total }
    policy { actor.is(Clerk) && account == tenant }
  }

  query MyOrders from Order {
    where { account == actor.account }
    policy { actor.is(Customer) }
  }

  usecase Close (order: Order) {
    step Refund(order, order.total)
    policy { actor.is(Clerk) }
  }
}
```

## Narrowing

Higher layers inherit the definitions, constraints and policies of lower layers and may only narrow them, never widen them. In practice:

- Policies are local. Each one sits next to the element it protects, and the effective policy at any point is the conjunction of all policies along the reference path: a use case that runs an action is guarded by the use case policy and by the action policy, and the action works on an entity guarded by the entity policies.
- A query inherits the policies of its entity and can add its own.
- [Projections](application.md#projections) expose fewer fields, or computed ones; they are the only place where a shape may diverge from the entity.
- [Interfaces](interfaces.md) add transport restrictions (`auth`, `limit`, `cors`); they can only restrict further.

> [!NOTE]
> The validator checks where policies may appear and that their conditions are Bool. It does not compute the effective policy. Code generators turn each policy into a task in the [registry](../codegen/registry.md).

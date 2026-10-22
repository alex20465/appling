---
title: Expressions
description: The typed CEL subset used for conditions, defaults, derived fields, filters, effects and call arguments.
---

Expressions are written inside braces (`requires { ... }`, `where { ... }`, `policy { ... }`) or after `default`, `=` and in call arguments. They use a small, typed, side effect free subset of [CEL](https://cel.dev). Every expression is type checked against what its position expects, and every name in it resolves against its position.

## Syntax

```appling
total >= 0
status in [placed, paid]
actor.is(crm.Clerk) || customer == actor.account
sum(lines.map(l, l.amount))
created_at < now - duration("720h")
lines.exists(l, l.amount > 0) && !has(paid_at)
```

### Literals

| Literal | Type |
|---|---|
| `"text"` | `String` |
| `42` | `Int` |
| `0.5` | `Decimal` (a number with a fraction) |
| `true`, `false` | `Bool` |
| `null` | Fits only optional types |
| `[a, b]` | A list of the first item's type |

### Operators

From lowest to highest precedence:

| Operators | Meaning |
|---|---|
| `\|\|` | Or |
| `&&` | And |
| `==`, `!=`, `<`, `<=`, `>`, `>=`, `in` | Comparison and membership; at most one per level, so write `(a < b) == c` with parentheses |
| `+`, `-` | Addition, subtraction, concatenation |
| `*`, `/`, `%` | Multiplication, division, remainder |
| `!`, `-` | Not, negation (prefix) |
| `x.f`, `x.m(...)`, `x[i]` | Field access, method call, list index |

Parentheses group as usual.

## Types

Every expression has a type: a primitive (`String`, `Text`, `Int`, `Decimal`, `Money`, `Bool`, `Date`, `DateTime`, `Duration`, `File`, `Uuid`), an enum, a value type, an entity, a list of one of these, or the current actor. Any of them can be optional, written with `?`.

| Group | Types |
|---|---|
| Numeric | `Int`, `Decimal`, `Money` (in this order of width) |
| Text | `String`, `Text` |
| Temporal | `Date`, `DateTime` |
| Ordered | numeric, temporal, `Duration`, text |

### Operator rules

| Expression | Operands | Result |
|---|---|---|
| `a \|\| b`, `a && b` | `Bool` | `Bool` |
| `!a` | `Bool` | `Bool` |
| `-a` | numeric or `Duration` | the operand type |
| `a == b`, `a != b` | comparable | `Bool` |
| `a < b` and the other orderings | comparable and ordered | `Bool` |
| `a in list` | `list` items comparable with `a` | `Bool` |
| `a + b`, `a - b`, `a * b`, `a / b`, `a % b` | numeric | the wider of the two |
| `a + b` | text | `String` |
| `t + d`, `t - d` | `t` temporal or `Duration`, `d` `Duration` | the type of `t` |
| `t1 - t2` | temporal | `Duration` |
| `d * n`, `d / n` | `d` `Duration`, `n` numeric | `Duration` |
| `l1 + l2` | lists with comparable items | the list type |
| `l[i]` | a list and an `Int` | the item type |

Two types are comparable when they are both numeric, both text, the same primitive, the same declaration, or lists of comparable items. `null` compares with anything.

Arithmetic and negation produce a non optional result. Reading a field through an optional value gives an optional result: `order.customer.name` is optional when `customer` is.

### Assignability

Where a position expects a type (a field default, a derived field, an effect assignment, a call argument), the value must fit it:

- `null` fits only an optional type.
- A narrower numeric type fits a wider one: an `Int` fits `Decimal` and `Money`, a `Decimal` fits `Money`, not the other way round.
- A list fits a list whose items fit.
- Otherwise the types must be comparable and of the same kind.

Conditions (invariants, policies, preconditions, guards, filters) must be `Bool`.

## Name resolution

Names in expressions are not references. They resolve by the position of the expression.

### Everywhere

| Name | Stands for | Type |
|---|---|---|
| `actor` | The current actor | The actor; its fields are those declared by any actor in the workspace |
| `now` | The current time | `DateTime` |
| `tenant` | The current tenant | The entity of the single declared [tenant](access.md#tenants); unknown when there is none or more than one |

### Per position

| Position | Also visible | Expected type |
|---|---|---|
| Entity field `default` or `= derived` | The entity's fields, `this` | The field type |
| Value type, event or actor field `default` or `= derived` | The fields of that declaration | The field type |
| `invariant` | The entity's fields, `this` | `Bool` |
| Entity `policy` | The entity's fields, `this` | `Bool` |
| Action `policy`, `requires` | The fields of the action's entity, `this`, the action's inputs | `Bool` |
| `effect` in an action: `set`, `create`, `emit` values | The fields of the action's entity, `this`, the action's inputs | The assigned field's type |
| Transition `when` | The fields of the machine's entity, `this` | `Bool` |
| Transition `effect` values | The fields of the machine's entity, `this` | The assigned field's type |
| Job `where` | The fields of the run action's entity, `this`, the run action's inputs | `Bool` |
| Query `where`, query `policy` | The fields of the query's entity, `this` | `Bool` |
| Projection computed field | The fields of the source entity (the query's entity for a query source), `this` | Any |
| Use case `policy` | The use case's parameters | `Bool` |
| Call arguments in `step`, `on ... do`, `await ... do` | The use case's parameters | The parameter type at that position |

An action without `on <Entity>` has no `this` and no entity fields, only its inputs.

### this

`this` is the record the expression is about: the entity in entity, action, transition, job, query and projection positions. Its type is the entity, so it fits a field of that entity type: `emit OrderPlaced { order = this }`.

### Bare enum values

You write an enum value without its enum: `draft`, not `OrderStatus.draft`. A bare value takes its type from the context:

- the other side of a comparison: `status == draft`,
- the left side of `in` for the list items: `status in [placed, paid]`,
- the field it is assigned to: `default draft`, `set priority = high`,
- the parameter it is passed to in a call.

A name that is neither visible at the position nor a value of the expected enum is an error: `Unknown name "missing".`

## Builtins

| Builtin | Argument | Type |
|---|---|---|
| `duration(s)` | `String` or `Text`, such as `"24h"` | `Duration` |
| `size(x)`, `x.size()` | A list, `String` or `Text` | `Int` |
| `has(x)` | Any expression, typically an optional field | `Bool` |
| `sum(list)`, `min(list)`, `max(list)` | A list of numbers or `Duration` | The item type |
| `list.map(x, expr)` | A variable and an expression over it | A list of the expression type |
| `list.filter(x, cond)` | A variable and a `Bool` condition | The list type |
| `list.exists(x, cond)` | A variable and a `Bool` condition | `Bool` |
| `list.all(x, cond)` | A variable and a `Bool` condition | `Bool` |
| `s.contains(t)`, `s.startsWith(t)`, `s.endsWith(t)`, `s.matches(t)` | `s` and `t` text | `Bool` |
| `actor.is(X)` | A role or actor name, plain or dotted (`crm.Clerk`) | `Bool` |

The functions take exactly one argument. In `map`, `filter`, `exists` and `all`, the first argument is a variable name bound to each item inside the second argument.

## Example

```appling check
module sales {
  role Clerk
  actor human Shopper {
    account: Account
  }

  enum OrderStatus {
    draft
    placed
    paid
  }

  value Line {
    product: String
    amount: Money
  }

  entity Account {
    name: String
  }

  tenant Company on Account

  entity Order {
    reference: String unique
    account: Account
    lines: Line[]
    status: OrderStatus state default draft
    created_at: DateTime
    paid_at: DateTime?
    total: Money = sum(lines.map(l, l.amount))
    big_lines: Int = size(lines.filter(l, l.amount > 100))
    age: Duration = now - created_at

    invariant "has lines" { lines.size() > 0 && lines.all(l, l.amount >= 0) }
    invariant "reference format" { reference.startsWith("SO") && !reference.contains(" ") }

    policy read { actor.is(Clerk) || account == actor.account }
    policy update { account == tenant && status in [draft, placed] }
  }

  query Stale from Order {
    where { status == draft && created_at < now - duration("720h") && !has(paid_at) }
  }

  projection OrderRow from Order {
    reference
    line_count = lines.size()
    net = total * 0.8
  }
}
```

## How tools use the typer

Besides checking, the expression typer records which element every name stands for. The [semantic graph](../reference/graph.md) turns these into `uses` edges, and the rename [edit operation](../reference/edit-operations.md) follows them, so renaming a field also renames it inside every expression that reads it.

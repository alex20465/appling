---
title: Validation rules
description: Every rule the validator and the expression typer enforce, with the message each one reports.
---

`appling check`, the language server and every tool that edits the model run the same validation. A model with errors is not graphed, released or generated, and an edit that adds an error is rejected. This page lists every rule, grouped, with the message it reports. In the messages, names in angle brackets stand for the actual names.

Messages show types the way you write them: `Int`, `Order`, `Line[]`, `DateTime?`. The type of an expression that already failed shows as `unknown`, and the current actor as `actor`.

## Syntax and references

| Rule | Message |
|---|---|
| The text must parse | The parser's message, such as ``Expecting token of type ':' but found `Int`.`` |
| Every reference must resolve to a visible declaration of the right kind | `Could not resolve reference to <Kind> named '<name>'.` |

A reference resolves only against what is visible from its position. Another module's declarations are visible only when exported, by their module path; see [modules](modules.md#visibility-rules).

```appling
module crm {
  entity Account {
    name: String
  }
}

module sales {
  entity Order {
    customer: crm.Account // Could not resolve reference to TypeDecl named 'crm.Account'.
  }
}
```

## Modules

| Rule | Message |
|---|---|
| An exported name must be a direct member of the module | `Module <module> has no member "<name>" to export.` |

```appling
module m {
  export Missing // Module m has no member "Missing" to export.
}
```

## Layers

| Rule | Message |
|---|---|
| A reference must follow the layer order | `<layer> element <Kind> may not reference <layer> element <Kind> "<name>".` |

The allowed references are listed under [reference rules](overview.md#reference-rules). The layers in the message are spelled `cross`, `domain`, `behavior`, `application`, `interface` and `experience`.

## State machines

| Rule | Message |
|---|---|
| A machine governs an entity field marked `state` with an enum type | `A machine must govern an entity field marked "state" with an enum type.` |
| Each state field has at most one machine | `State field <field> is already owned by another machine.` |
| Every state in a transition is a value of the field's enum | `"<state>" is not a value of <Enum>.` |
| A `set` effect never changes a `state` field | `A state field changes only through a machine transition.` |

```appling
enum Status {
  open
  done
}
entity Order {
  status: Status state
  kind: Status
}
action Close on Order {
}
action Reopen on Order {
  effect {
    set status = open // A state field changes only through a machine transition.
  }
}
machine KindFlow on Order.kind { // A machine must govern an entity field marked "state" with an enum type.
}
machine Flow on Order.status {
  transition open -> closed via Close // "closed" is not a value of Status.
}
```

## Policies

| Rule | Message |
|---|---|
| Operations and `fields` appear only on entity policies | `Operations and fields narrow entity policies only.` |

```appling
action Edit on Order {
  policy read { true } // Operations and fields narrow entity policies only.
}
```

## Projections and endpoints

| Rule | Message |
|---|---|
| A picked projection field exists on the source entity | `<Entity> has no field "<name>". Use "<name> = <expression>" for a computed field.` |
| An endpoint that targets a query names a projection | `An endpoint exposes query results only through a projection: add "as <Projection>".` |

```appling
projection Summary from Order {
  missing // Order has no field "missing". Use "missing = <expression>" for a computed field.
}
query All from Order {
}
interface rest Api {
  GET "/orders" -> All // An endpoint exposes query results only through a projection: add "as <Projection>".
}
```

## Migrations

| Rule | Message |
|---|---|
| A renamed or retyped element exists after replaying the later steps | `Module <module> has no element <path>.` |
| A removed element no longer exists after replaying the later steps | `Removed element <path> still exists.` |

```appling
entity Order {
  note: String
}
migration One {
  rename Order.missing -> other // Module m has no element Order.other.
  remove Order.note // Removed element Order.note still exists.
}
```

See [migrations](migrations.md#the-replay-rule) for how steps are replayed.

## Expressions

The expression typer checks every expression and every call. See [expressions](expressions.md) for the typing rules.

### Names and fields

| Rule | Message |
|---|---|
| A name is visible at its position, or is a value of the expected enum | `Unknown name "<name>".` |
| A field access names a field of the receiver | `<Type> has no field "<field>".` |
| An assignment in `create` or `emit` names a field of the entity or event | `<Entity or Event> has no field "<name>".` |

```appling
entity Note {
  o: Order
  invariant "a" { missing } // Unknown name "missing".
  invariant "b" { o.nope == 1 } // Order has no field "nope".
}
action Finish on Order {
  effect {
    emit Closed { nope = this } // Closed has no field "nope".
  }
}
```

### Types

| Rule | Message |
|---|---|
| A condition is `Bool` (invariants, policies, preconditions, guards, filters, `filter`/`exists`/`all` bodies) | `A condition must be Bool, not <Type>.` |
| A value fits the field or parameter it is assigned to; `null` fits only optional types | `<Type> is not assignable to <Type>.` |
| A prefix operator applies to its operand (`!` to `Bool`, `-` to numbers and `Duration`) | `Operator "<op>" does not apply to <Type>.` |
| A binary operator applies to its operands | `Operator "<op>" does not apply to <Type> and <Type>.` |
| An index applies to a list with an `Int` | `<Type> cannot be indexed by <Type>.` |

```appling
entity Note {
  count: Int default "zero" // String is not assignable to Int.
  other: Int default null // null is not assignable to Int.
  invariant "a" { 1 + 2 } // A condition must be Bool, not Int.
  invariant "b" { "a" > 1 } // Operator ">" does not apply to String and Int.
  invariant "c" { !1 } // Operator "!" does not apply to Int.
}
```

### Functions and methods

| Rule | Message |
|---|---|
| A function is one of `duration`, `sum`, `min`, `max`, `size`, `has` | `Unknown function "<name>".` |
| A function takes one argument | `<name>() takes 1 argument, got <n>.` |
| `duration` takes text | `duration() takes a String, not <Type>.` |
| `size` takes a list or text | `size() takes a list or String, not <Type>.` |
| `sum`, `min`, `max` take a list of numbers or durations | `<name>() takes a list of numbers, not <Type>.` |
| A method exists for the receiver and arguments | `<Type> has no method "<name>" for these arguments.` |
| `map`, `filter`, `exists`, `all` take a variable name and an expression | `<name>() takes a variable name and an expression.` |
| `actor.is` takes exactly one name | `actor.is() takes one role or actor name.` |
| The name in `actor.is` is a visible role or actor | `"<name>" is not a role or actor.` |

```appling
entity Note {
  n: Int
  l: Int[]
  d: Duration = duration(1) // duration() takes a String, not Int.
  invariant "a" { nope(1) } // Unknown function "nope".
  invariant "b" { n.upper() } // Int has no method "upper" for these arguments.
  invariant "c" { l.exists(1) } // exists() takes a variable name and an expression.
  policy read { actor.is(Nobody) } // "Nobody" is not a role or actor.
}
```

### Calls

| Rule | Message |
|---|---|
| A call in a use case passes as many arguments as the target takes: an action on an entity takes the entity and its inputs, optional inputs and parameters may be left out, a query takes none | `<Target> takes <n> argument(s), got <m>.` or `<Target> takes <n> to <m> argument(s), got <k>.` |
| Each argument fits its parameter | `<Type> is not assignable to <Type>.` |

```appling
action Close on Order {
  input {
    reason: String?
  }
}
usecase A (o: Order) {
  step Close() // Close takes 1 to 2 argument(s), got 0.
}
usecase B (o: Order) {
  step Close(o, 5) // Int is not assignable to String?.
}
```

## Not checked

Some things are left to you or to the tools:

- Duplicate names: two declarations with the same name in one module are not reported.
- `create` and `emit` do not have to assign every field of the entity or event.
- The old type in a `retype` step is not compared with the model.
- Message keys are plain names, not references.
- The protocol of an interface, the verb of an endpoint, the `auth` scheme and the `every` schedule of a job are free text.

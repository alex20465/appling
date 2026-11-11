---
title: Validation rules
description: Every rule the validator and the expression typer enforce, with the message each one reports.
---

`appling check`, the language server and every tool that edits the model run the same validation. A model with errors is not graphed, released or generated, and an edit that adds an error is rejected. This page lists every rule, grouped, with the message it reports. Rules marked as a warning are reported but do not block anything. In the messages, names in angle brackets stand for the actual names.

Messages show types the way you write them: `Int`, `Order`, `Line[]`, `DateTime?`. The type of an expression that already failed shows as `unknown`, and the current actor as `actor`. An actor field declared with different types shows as their union, `Customer | Vendor`.

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
| An exported name must be a direct member of the module | `Could not resolve reference to Member named '<name>'.` |

```appling
module m {
  export Missing // Could not resolve reference to Member named 'Missing'.
}
```

## Layers

| Rule | Message |
|---|---|
| A reference must follow the layer order | `<layer> element <Kind> may not reference <layer> element <Kind> "<name>".` |

The allowed references are listed under [reference rules](overview.md#reference-rules). The layers in the message are spelled `cross`, `domain`, `behavior`, `application`, `interface` and `experience`.

## Descriptions

| Rule | Message |
|---|---|
| `@Name` in a `does` text names a visible element | `Unknown element "@<name>" in does.` |
| `@Name` follows the layer order, except in a module's own description | `<layer> element <Kind> may not reference <layer> element <Kind> "@<name>".` |

See [descriptions](descriptions.md#naming-elements).

## State machines

| Rule | Message |
|---|---|
| A machine governs an entity field marked `state` with an enum type | `A machine must govern an entity field marked "state" with an enum type.` |
| Each state field has at most one machine | `State field <field> is already owned by another machine.` |
| Every state in a transition is a value of the field's enum | `"<state>" is not a value of <Enum>.` |
| `after` is a positive duration | `"<text>" is no duration such as "24h".` |
| `since` is a stored date | `<field> is no stored Date or DateTime.` |
| A `set` effect never changes a `state` field | `A state field changes only through a machine transition.` |

## Effects

| Rule | Message |
|---|---|
| `for` iterates a field of the entity whose type is a list of records | `"for" iterates a collection relationship of <Entity>, and <field> is no list of records.` |
| `update` and `delete` take a field, loop variable or `as` name followed by fields, leading to one record | `"update" takes a relationship path to one record, such as item.product.` (with `; for every record of a collection, use "for"` for a list) |
| `delete self` needs an action on an entity | `"delete self" needs an action on an entity.` |
| A loop variable or `as` name hides no other name | `"<name>" is already a name here; pick another one.` |

A loop variable is visible inside its loop and an `as` name after its `create` only; elsewhere they are `Unknown name "<name>".` A `set` inside `update` names a field of the updated record, or `Could not resolve reference to Field named '<field>'.`

## Policies

| Rule | Message |
|---|---|
| Operations and `fields` appear only on entity policies | `Operations and fields narrow entity policies only.` |
| Every `\|\|` branch of a policy grants by role (warning) | `A policy grants by role: every "\|\|" branch needs actor.is(Role), or write { false }.` |
| A role condition reads only `actor`, `tenant` and `now` | `A role condition reads only actor, tenant and now, not "<name>".` |

## Projections and endpoints

| Rule | Message |
|---|---|
| A picked projection field exists on the source entity | `<Entity> has no field "<name>". Use "<name> = <expression>" for a computed field.` |
| An endpoint that targets a query names a projection | `An endpoint exposes query results only through a projection: add "as <Projection>".` |
| A query input does not have the name of a field of the query's entity | `Input <name> of query <Query> hides the field <name> of <Entity>; rename the input.` |
| Every `{name}` in the path of a query endpoint names an input of the query | `Path parameter {<name>} is not an input of query <Query>.` |
| The inputs of a query endpoint have types a URL can carry: no value type, no `File` | `Input <name> of query <Query> has the type <Type>, which a URL cannot carry.` |

## Externals and vendors

| Rule | Severity | Message |
|---|---|---|
| A `setting` or `secret` has a primitive type, not a list | error | `A <setting or secret> has a primitive type, not <Type>.` |
| A `webhook` interface names its external with `from` | error | `A webhook interface names its vendor: "interface webhook <Name> from <External>".` |
| A `webhook` interface has endpoints | warning | `Webhook interface <Name> has no endpoints.` |
| An external with settings or secrets is called by a step or named by an interface | warning | `External <Name> declares settings or secrets, but nothing calls or names it.` |

```appling
external Mail {
  secret key: String[] // A secret has a primitive type, not String[].
}
interface webhook Events { // A webhook interface names its vendor: "interface webhook Events from <External>".
  POST "/hooks" -> Sync
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

## Scenarios

| Rule | Message |
|---|---|
| A name is given once per scenario | `"<name>" is already given in this scenario.` |
| A role after `as` is held by some actor | `No actor holds the role <Role>: declare one with "roles <Role>" or name an actor.` |
| Actor fields follow an actor, not a role | `Role <Role> has no fields: name an actor after "as" to give "<field>".` |
| An actor field exists on the actor or its entity | `Actor <Actor> has no field "<field>".` |
| `when` calls an action or a use case | `A scenario's when calls an action or a use case, not query <Query>.` (or `external operation <Op>`) |
| `fails <Error>` names an error of the action, or of what the use case calls | `Could not resolve reference to ErrorDecl named '<name>'.` |
| A scenario's `then` holds when the simulator runs it (`appling check` only, once nothing else fails) | `Scenario <Name> fails: <reason>.`, see [scenarios](scenarios.md#how-check-runs-scenarios) |


## Expressions

The expression typer checks every expression and every call. See [expressions](expressions.md) for the typing rules.

### Names and fields

| Rule | Message |
|---|---|
| A name is visible at its position, or is a value of the expected enum | `Unknown name "<name>".` |
| `tenant` is read only when the workspace declares exactly one tenant | `"tenant" needs exactly one tenant in the workspace, which declares no tenant.` (or `declares <n> tenants`) |
| An enum value named with its enum exists in that enum | `Enum <Enum> has no value "<name>".` |
| A field access names a field of the receiver | `<Type> has no field "<field>".` |
| An assignment in `create`, `emit` or a scenario's `given` or `emitted` names a field of the entity or event | `<Entity or Event> has no field "<name>".` |

### Types

| Rule | Message |
|---|---|
| A condition is `Bool` (invariants, policies, preconditions, guards, filters, scenario checks, `filter`/`exists`/`all` bodies) | `A condition must be Bool, not <Type>.` |
| A value fits the field or parameter it is assigned to; `null` fits only optional types | `<Type> is not assignable to <Type>.` |
| A prefix operator applies to its operand (`!` to `Bool`, `-` to numbers and `Duration`) | `Operator "<op>" does not apply to <Type>.` |
| A binary operator applies to its operands | `Operator "<op>" does not apply to <Type> and <Type>.` |
| An index applies to a list with an `Int` | `<Type> cannot be indexed by <Type>.` |

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

### Calls

| Rule | Message |
|---|---|
| A call in a use case or a scenario passes as many arguments as the target takes: an action on an entity takes the entity and its inputs, a query takes its inputs, optional inputs and parameters may be left out | `<Target> takes <n> argument(s), got <m>.` or `<Target> takes <n> to <m> argument(s), got <k>.` |
| Each argument fits its parameter | `<Type> is not assignable to <Type>.` |

## Not checked

Some things are left to you or to the tools:

- Duplicate names: two declarations with the same name in one module are not reported.
- `create` and `emit` do not have to assign every field of the entity or event.
- The old type in a `retype` step is not compared with the model.
- Message keys are plain names, not references.
- The protocol of an interface, the verb of an endpoint, the `auth` scheme and the `every` schedule of a job are free text.

---
title: Domain layer
description: L1 declares what exists, with enums, value types, entities, their fields, invariants and policies.
---

The domain layer (L1) describes what exists: the data of the application and the rules that hold for every stored record. It is the bottom layer, so its declarations reference only other domain declarations and cross cutting ones. Its keywords are `enum`, `value` and `entity`.

## Enums

An enum is a closed set of named values.

```appling
enum OrderStatus {
  draft
  placed
  paid
  cancelled
}
```

Each value is an element with its own qualified name, such as `sales.OrderStatus.draft`. In expressions, you write a value without the enum name, as a [bare enum value](expressions.md#bare-enum-values): `status == draft`.

## Value types

A value type is a structured value without identity of its own, stored inside the entity that uses it.

```appling
value Line {
  product: String
  quantity: Int
  amount: Money
}
```

Value fields follow the same [field syntax](#fields) as entity fields. Their defaults and derived values can read the other fields of the same value type.

## Entities

An entity is something with identity that the application stores. It holds fields, invariants and policies in any order.

```appling check
module sales {
  enum OrderStatus {
    draft
    placed
    paid
    cancelled
  }

  value Line {
    product: String
    quantity: Int
    amount: Money
  }

  entity Customer {
    name: String unique
  }

  entity Order {
    reference: String unique
    customer: Customer
    lines: Line[] owned
    status: OrderStatus state default draft
    created_at: DateTime
    placed_at: DateTime?
    total: Money = sum(lines.map(l, l.amount))

    invariant "total never negative" { total >= 0 }

    policy read { actor.is(Clerk) || actor.is(Customer) }
    policy read fields total { actor.is(Clerk) || (actor.is(Customer) && status != draft) }
  }

  role Clerk
  role Customer
}
```

### Link entities

Some entities exist only to connect others, such as the join record of a many to many relationship. Mark them with `link` after `entity`. A link entity is an ordinary entity in every other respect: it has fields, invariants and policies, and code generation treats it like any other entity. The marker tells tools that it is secondary to the business logic, so the [IDE](../tools/ide.md#the-entity-view) hides it by default.

```appling check
module catalog {
  entity Product {
    name: String unique
  }

  entity Tag {
    label: String unique
  }

  entity link ProductTag {
    product: Product
    tag: Tag
  }
}
```

`link` remains a valid name, so `entity link { ... }` declares an entity called `link`.

## Fields

A field has a name, a type, optional modifiers, an optional default and an optional derived value, in this order:

```text
name: Type[]? modifiers default <expression> = <expression>
```

### Field types

| Type | Holds |
|---|---|
| `String` | Short text |
| `Text` | Long text |
| `Int` | Whole number |
| `Decimal` | Decimal number |
| `Money` | Amount of money |
| `Bool` | `true` or `false` |
| `Date` | Calendar date |
| `DateTime` | Point in time |
| `Duration` | Length of time |
| `File` | Uploaded file or blob |
| `Uuid` | Universally unique identifier |
| An `enum` | One of its values |
| A `value` type | An embedded structured value |
| An `entity` | A relationship to a record of that entity |

The type may be a declaration from another module by its path, such as `crm.Account`, when that module exports it.

Two suffixes change the type:

| Suffix | Meaning | Example |
|---|---|---|
| `[]` | A list of the type | `lines: Line[]`, `tags: String[]` |
| `?` | Optional: the field may be empty (`null`) | `placed_at: DateTime?` |

Both can combine, list first: `notes: Text[]?`. A field without `?` is required.

For typing, `Int`, `Decimal` and `Money` are the numeric types (an `Int` fits where a `Decimal` or `Money` is expected, not the other way round), `String` and `Text` compare with each other, and `Date` and `DateTime` are the temporal types. See [expressions](expressions.md#types).

### Modifiers

| Modifier | Meaning |
|---|---|
| `unique` | No two records share the value |
| `state` | The field is the state of the entity. It must have an enum type, and only a [machine](behavior.md#machines) changes it. |
| `owned` | The referenced records belong to this entity and go away with it, for example the lines of an order |

### Defaults

`default <expression>` gives a field its initial value. The expression must fit the field type; a bare enum value works because it takes its type from the field.

```appling
status: OrderStatus state default draft
amount: Decimal default 0
```

`null` fits only an optional field: `count: Int default null` is an error, `null is not assignable to Int.`

### Derived fields

`= <expression>` makes a field derived: its value is computed from other fields instead of stored. The expression must fit the field type.

```appling
total: Money = sum(lines.map(l, l.amount))
```

Inside an entity, defaults and derived values can read the entity's fields, `this`, `actor`, `now` and `tenant`. See [expressions](expressions.md#name-resolution).

## Invariants

An invariant is a condition that must hold for every stored record of the entity. It has a label and a Bool condition.

```appling
invariant "total never negative" { total >= 0 }
invariant "paid after placed" { !has(paid_at) || paid_at > placed_at }
```

The label identifies the invariant: its qualified name is `sales.Order.invariant["total never negative"]`.

Put a rule that must always be true here. A rule that must be true only for one action to run belongs to that action as a [precondition](behavior.md#preconditions).

## Policies

Entity policies guard the records and fields of the entity. They can name the operations they cover (`read`, `create`, `update`, `delete`) and the fields they protect.

```appling
policy read { actor.is(crm.Clerk) || (actor.is(Customer) && customer == actor.account) }
policy create, update, delete { actor.is(crm.Clerk) }
policy read fields total { actor.is(crm.Clerk) || (actor.is(Customer) && status != draft) }
```

See [access](access.md#policies) for the full rules.

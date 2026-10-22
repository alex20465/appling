---
title: Edit operations
description: The five validated operations that change a model by qualified name, what each one touches, when an edit is rejected, and how edits record migration steps after a release.
---

Tools never patch Appling text by hand. They change the model through five edit operations that address elements by qualified name: `add`, `rename`, `retype`, `remove` and `set`. The IDE inspector and graph, the IDE chat and the MCP `edit` tool all use them. Each operation is applied to the text, the touched element is printed canonically, the result is validated, and the edit is rejected when it would make the model worse.

## applyEdit

```ts
import { applyEdit } from '@appling/model';

const result = await applyEdit(sources, { op: 'rename', target: 'sales.Order.total', name: 'amount' });
if (result.ok) {
  result.sources; // every source with the edit applied
  result.edits;   // minimal text edits: { uri, offset, length, text }
} else {
  result.errors;  // why the edit was rejected
}
```

| Parameter | Meaning |
|---|---|
| `sources` | The whole workspace as `{ [uri]: text }`. Include every file, so references across files resolve and renames reach them |
| `operation` | One of the operations below |
| `options.release` | Optional. A release from `readReleases`, usually `latestRelease(readReleases(root))`; turns on [release aware edits](#release-aware-edits) |

`applyEdit` writes nothing. On success it returns the changed texts and one text edit per changed file, covering the smallest range that differs, so an editor can apply it as one undoable step. Unchanged files are left out of `edits`.

## Examples

The examples on this page start from this model, in one file:

```appling check
module crm {
  export Account

  entity Account {
    name: String
  }
}

module sales {
  enum OrderStatus {
    draft
    placed
  }

  entity Order {
    customer: crm.Account
    status: OrderStatus state default draft
    total: Money

    invariant "total never negative" { total >= 0 }
  }
}
```

## add

```ts
{ op: 'add', parent: 'sales.Order', source: 'note: Text?' }
```

| Field | Meaning |
|---|---|
| `parent` | The qualified name of the element to add to |
| `source` | Appling source of exactly one new member, such as a field, `invariant "..." { ... }`, `requires { ... } else E` or, for a module, a whole declaration |

The source goes at the last position inside the parent where it parses as one more member of that parent. The parent is then printed canonically. The example adds the field at the end of the entity:

```appling
  entity Order {
    customer: crm.Account
    status: OrderStatus state default draft
    total: Money

    invariant "total never negative" { total >= 0 }
    note: Text?
  }
```

When no position fits, the edit is rejected with `"<source>" does not fit into <parent>.`, for example for `entity X {}` inside an entity.

## rename

```ts
{ op: 'rename', target: 'sales.Order.total', name: 'amount' }
```

| Field | Meaning |
|---|---|
| `target` | The qualified name of the element |
| `name` | The new name, without module path |

Rename changes only name tokens, never the layout. It follows every place that names the element:

- references, also as one segment of a qualified name, such as `Account` in `crm.Account`, or `Order` in `Order.status`,
- names in expressions, such as `total` in an invariant or a bare enum value used as a default,
- transitions of machines over a renamed enum value (`transition draft -> placed`),
- the module's `export` list, for a top level declaration,
- message keys that name the element, such as `Order.total = "Total"`,
- projection fields without a value that copy an entity field by name: they are renamed with the field.

The example renames the field and the name in the invariant:

```appling
    total: Money
    invariant "total never negative" { total >= 0 }
```

becomes

```appling
    amount: Money
    invariant "total never negative" { amount >= 0 }
```

Renaming the enum value `sales.OrderStatus.draft` to `open` changes both the value and the default `default open`.

## retype

```ts
{ op: 'retype', target: 'sales.Order.total', type: 'Decimal' }
```

| Field | Meaning |
|---|---|
| `target` | A field or parameter |
| `type` | The new type in Appling syntax, such as `Money`, `crm.Account`, `Line[]` or `DateTime?` |

Retype replaces the type and prints the element canonically: `total: Money` becomes `total: Decimal`. It is rejected when the new type breaks something, for example an expression that no longer type checks.

## remove

```ts
{ op: 'remove', target: 'sales.Order.status' }
```

| Field | Meaning |
|---|---|
| `target` | The qualified name of the element |

Remove deletes the element's text with the whitespace before it. In a comma separated list, such as the errors of an action, it also removes the separating comma. For a top level declaration it removes its name from the module's `export` list, and the whole `export` line when that was its only name.

Remove does not remove what still refers to the element; the edit is rejected instead. Removing `crm.Account` from the example fails with `Could not resolve reference to TypeDecl named 'crm.Account'.`, and removing `sales.Order.total` fails with `Unknown name "total".` because the invariant uses it. Remove the references first.

## set

```ts
{ op: 'set', target: 'sales.Order.status', property: 'default', value: 'placed' }
```

| Field | Meaning |
|---|---|
| `target` | The qualified name of the element |
| `property` | A property name as the graph's `props` shows it, such as `default`, `derived`, `condition`, `modifiers`, `label`, `preconditions` or `schedule` |
| `value` | Appling source for the property; empty removes it |

Set covers three cases:

| Property | `value` | Result |
|---|---|---|
| present | not empty | Replaces the property's text: `default draft` becomes `default placed` |
| present | empty | Removes the property with its keyword: `status: OrderStatus state default draft` becomes `status: OrderStatus state` |
| absent | not empty | Inserts it with its keyword where it parses: `set` of `modifiers` to `unique` on `total` gives `total: Money unique` |

The element is printed canonically afterwards. Set is rejected with `Cannot set <property> on <kind>.` when the value cannot be placed. For a list property such as `modifiers` or `preconditions`, the value replaces the whole list, from its first to its last item.

## Rejection rules

An edit is rejected, and nothing changes, when:

| Reason | Message |
|---|---|
| No element has the qualified name | `No element sales.Nope.` |
| An added member fits nowhere in the parent | `"entity X {}" does not fit into sales.Order.` |
| A property cannot be set on that element | `Cannot set <property> on <kind>.` |
| The edited text does not parse | `The edit does not parse.` |
| Two changes of one rename overlap | `The edit touches overlapping text.` |
| Validation reports an error that was not there before | The new error messages, such as `Unknown name "total".` |

Errors that existed before the edit do not block it, so you can edit a model that is still incomplete. Only new errors count.

## Release aware edits

After `appling release`, the model's domain elements are part of a released schema, and generated projects and databases depend on them. When `applyEdit` gets a release, an edit of a released element also records a migration step, so [`appling generate --migrate`](../tools/cli.md#migrate) can carry it into generated projects.

A step is appended when all of this holds:

- the operation is `rename`, `retype` or `remove`,
- the element is named and belongs to a domain (L1) declaration: an enum, value type or entity, or one of their members,
- the element exists in the release, traced back through renames already recorded since the release.

The step goes into the module's `migration since_v<version>` block, which is created at the end of the module when it does not exist. The step uses the element's path inside its module as it is before the edit:

| Operation | Step |
|---|---|
| `rename` | `rename Order.total -> amount` |
| `retype` | `retype Order.amount: Money -> Decimal` |
| `remove` | `remove Order.legacy` |

Starting from the example model released as `1.0.0`, renaming `sales.Order.total` to `amount` and then retyping `sales.Order.amount` to `Decimal` gives:

```appling check
module crm {
  export Account

  entity Account {
    name: String
  }
}

module sales {
  enum OrderStatus {
    draft
    placed
  }

  entity Order {
    customer: crm.Account
    status: OrderStatus state default draft
    amount: Decimal

    invariant "total never negative" { amount >= 0 }
  }

  migration since_v1_0_0 {
    rename Order.total -> amount
    retype Order.amount: Money -> Decimal
  }
}
```

Elements added after the release get no steps: adding `note: Text?` and removing it again leaves the block unchanged. Elements outside the domain layer get no steps either. See [Migrations](../language/migrations.md) for the rules of migration blocks.

The IDE, the MCP server and the IDE chat always pass the latest release in the workspace's `.appling/releases/` folder.

---
title: Migrations
description: Migration blocks record renames, type changes and removals of stored data so tools can follow every element to its new name.
---

Elements are identified by their qualified name, so renaming a field changes its identity. A `migration` block records such changes as explicit steps in the model: renames, type changes and removals of data that may already be stored. Tools use the steps to follow an element to its new name, and code generation turns them into framework migrations that keep the data.

## Migration blocks

A migration is a cross cutting declaration inside a module. It has a name and a list of steps.

```appling check
module sales {
  entity Order {
    reference: String unique
    total: Money
  }

  migration v2 {
    rename Order.code -> reference
    retype Order.total: Decimal -> Money
    remove Order.legacy
  }
}
```

| Step | Form | Records |
|---|---|---|
| `rename` | `rename <path> -> <new name>` | The element at the path got a new name; the new name replaces the last segment of the path |
| `retype` | `retype <path>: <old type> -> <new type>` | The field at the path changed its type |
| `remove` | `remove <path>` | The element at the path was removed |

The types in `retype` use the [field type](domain.md#field-types) syntax, including `[]` and `?`.

## Paths

A step names its target by its path inside the module, without the module name: `Order.code`, not `sales.Order.code`. The path is the one the element had before the step. `rename Order.code -> reference` reads: the field that was `Order.code` is now `Order.reference`.

## The replay rule

The validator checks every step against the model as it is now. It takes all migration steps of the module, from every migration block in declaration order, and for each step:

1. Works out where the step leaves the element: the new path for a `rename`, the same path for `retype` and `remove`.
2. Replays the later steps of the module on that path. A later `rename` of the element or of one of its parents moves the path; a later `remove` of it ends the check for this step.
3. Requires the resulting path to exist for `rename` and `retype`, and not to exist for `remove`.

| Problem | Message |
|---|---|
| A renamed or retyped element is not in the model | `Module sales has no element Order.other.` |
| A removed element is still in the model | `Removed element Order.note still exists.` |

This lets steps chain across blocks. The first rename below points at `Order.ref`, which the later block renames to `Order.reference`, which exists:

```appling check
module sales {
  entity Order {
    reference: String unique
  }

  migration v2 {
    rename Order.code -> ref
  }

  migration v3 {
    rename Order.ref -> reference
  }
}
```

The validator checks only that the paths exist or are gone. It does not compare the old type of a `retype` with the model.

## Steps after a release

`appling release <version>` writes a snapshot of the semantic graph to `.appling/releases/<version>.json`. See the [CLI](../tools/cli.md#release).

Once a release exists, tools that edit the model through [edit operations](../reference/edit-operations.md), such as the [IDE](../tools/ide.md) and the [AI tools](../tools/ai.md), record the steps for you. When an edit renames, retypes or removes a domain (L1) element that the latest release contains, the tool appends the matching step to a migration block named after that release, `since_v<version>` with dots turned into underscores. It creates the block in the element's module when it does not exist yet.

For example, after `appling release 1.0.0`, renaming `Order.code` to `reference`, changing `Order.total` from `Decimal` to `Money` and then renaming `Order.reference` to `ref` in the IDE leaves:

```appling check
module sales {
  entity Order {
    ref: String
    total: Money
  }
  migration since_v1_0_0 {
    rename Order.code -> reference
    retype Order.total: Decimal -> Money
    rename Order.reference -> ref
  }
}
```

- Each step is written with the path the element had just before that edit, so the replay rule holds.
- Elements added after the release get no steps: they have no stored data yet.
- Edits of elements in other layers get no steps.
- When you edit the text by hand, no step is appended. Write the step yourself.

## In generated projects

`appling generate --migrate` carries the steps that a generated project has not applied yet into it, as framework migrations that keep the data. See [code generation migrations](../codegen/migrations.md).

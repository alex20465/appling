---
title: Descriptions
description: The does clause says in plain text what a declaration is or does, for what the structured constructs cannot express.
---

The structured constructs (`set`, `create`, `emit`, typed operations) say a lot, but not everything. How an external operation maps to a vendor's HTTP API, or what an action does beyond its effects, has no construct. The `does` clause writes it down next to the element, in plain text. Code generation turns it into a docstring and a [registry task](../codegen/registry.md), so the intent reaches whoever implements the element.

## Writing a description

Write `does` and a string after the head of a declaration (name, signature, `relevance`) and before its body, or at the end of a declaration without a body:

```appling check
module accounts does "Who signs in and what they may do" {
  external Clerk does "The identity provider that owns sign in" {
    op BanUser (id: String) does "POST /users/{id}/ban on the Clerk backend API; 404 means the user is gone"
  }

  entity Account does """
    Someone who signs in. The row mirrors the Clerk user;
    @Account.clerk_id is the link between both.
  """ {
    clerk_id: String unique does "The id Clerk assigns, user_ followed by letters"
    email: String
    banned: Bool default false
  }

  action Ban on Account does "Marks the @Account as banned so it can no longer sign in" {
    effect {
      set banned = true
    }
  }

  usecase BanAccount (account: Account) does "Bans the user at @Clerk first, then locally with @Ban" {
    step Clerk.BanUser(account.clerk_id)
    step Ban(account)
  }
}
```

Every named element takes one: `module`, `role`, `actor`, `tenant`, `enum` and its values, `value`, `entity`, fields, `event`, `action`, its inputs and errors, `machine`, `job`, `query`, `projection` and its fields, `external` and its operations, `usecase` and its parameters, `interface`, `page`, `navigation`, `flow`, `messages` and `migration`. Fields, parameters, errors, enum values, operations, `role`, `tenant` and `job` put it at the end.

`does` stays valid as a name, so a field may be called `does`.

## Text blocks

A text between `"""` and `"""` spans lines. Its value drops the line break after the opening quotes, the last line when it holds only the closing quotes, and the indentation all lines share; deeper indentation stays. `appling fmt` indents the lines one level deeper than the line the block starts on and puts the closing quotes on that line's level, so a block moves with its declaration. A text block takes no escapes; a short `"..."` string takes the usual ones (`\"`, `\\`).

## Naming elements

`@Name` inside the text names an element the way a qualified name in a reference does: `@Account`, `@Account.clerk_id`, `@Clerk.BanUser`, and across modules `@sales.Order` for exported members. A name is what follows `@` up to the first character that is not a letter, digit, `_` or a `.` followed by a letter, so a sentence may end right after it. An `@` that continues a word, as in `ops@shop.example`, is text.

Each name is checked like a reference:

| Rule | Error |
|---|---|
| The name resolves to a visible element | `Unknown element "@Nope" in does.` |
| The layer rules allow the reference, as for any [reference](overview.md#layers) | `behavior element Action may not reference application element External "@Clerk.BanUser".` |

A module's own description may name anything inside it. In the graph each name is a `uses` edge from the element, and [rename](../reference/edit-operations.md#rename) rewrites it.

## In the graph and in generated code

The text is the `does` property of the element's [graph node](../reference/graph.md), in `props` and `data`. Each extension turns it into documentation in the generated code ([Django](../codegen/django.md#descriptions): docstrings and `help_text`, [Ash](../codegen/ash.md#descriptions): `@moduledoc` and attribute `description`), and the planner adds one registry task per description: `implement what <Name> does: <text>` for actions, machines, jobs, queries, externals, their operations and use cases, `check that <Name> matches its description: <text>` for everything else.

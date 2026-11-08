---
title: Descriptions
description: The optional does clause adds a plain text note where the structured constructs leave something unclear, like a doc block in code.
---

The model describes itself: names, types, `requires`, `set`, `emit` and typed operations already say what an element is and does. Most declarations need nothing more. The `does` clause is an optional note in plain text for the few places where the structure cannot say it: how an external operation maps to a vendor's HTTP API, the format of a value, where a key comes from, why a rule exists. Treat it like a doc block in code: write one only when a reader would otherwise be confused.

Code generation turns each description into documentation and a [registry task](../codegen/registry.md), so the note reaches whoever implements the element. A description that only repeats the structure adds a task that says nothing new.

## When to write one

| Write `does` | Leave it out |
|---|---|
| The vendor call behind an operation: `POST /users/{id}/ban`, what a 404 means | An action whose `effect` already shows what it changes |
| A format or source the type cannot carry: "the id Clerk assigns, user_ followed by letters" | A field whose name and type say it all: `email: String` |
| A relation between elements that no reference states | A use case whose steps read as its description |
| Where to find a setting or secret | A module, entity or enum whose name is enough |

## Writing a description

Write `does` and a string after the head of a declaration (name, signature, `relevance`) and before its body, or at the end of a declaration without a body. In this module only three places need a note; the action and the use case explain themselves:

```appling check
module accounts {
  external Clerk {
    op BanUser (id: String) does "POST /users/{id}/ban on the Clerk backend API; 404 means the user is gone"
  }

  entity Account does """
    Mirrors the Clerk user;
    @Account.clerk_id is the link between both.
  """ {
    clerk_id: String unique does "The id Clerk assigns, user_ followed by letters"
    email: String
    banned: Bool default false
  }

  action Ban on Account {
    effect {
      set banned = true
    }
  }

  usecase BanAccount (account: Account) {
    step Clerk.BanUser(account.clerk_id)
    step Ban(account)
  }
}
```

Every named element can take one: `module`, `role`, `actor`, `tenant`, `enum` and its values, `value`, `entity`, fields, `event`, `action`, its inputs and errors, `machine`, `job`, `query`, `projection` and its fields, `external` and its operations, `usecase` and its parameters, `interface`, `page`, `navigation`, `flow`, `messages` and `migration`. Fields, parameters, errors, enum values, operations, `role`, `tenant` and `job` put it at the end.

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

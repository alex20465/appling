---
title: Descriptions
description: The optional describe clause notes what an element is where the structure leaves it unclear; an annotation names the work left to the code of a declaration.
---

The model describes itself: names, types, `requires`, `set`, `emit` and typed operations already say what an element is and does. Most declarations need nothing more. Optional clauses in plain text cover the rest:

| Clause | On | Says | Code generation |
|---|---|---|---|
| `describe` | every named element | what it is and what it is for: a vendor call, a format, where a key comes from | documentation |
| `holds` | `enum`, `value`, `entity` | data work the model does not state, such as a vendor mapping | documentation and a [registry task](../codegen/registry.md) |
| `does` | `event`, `action`, `machine`, `job` | work its code has to do | the same |
| `handles` | `query`, `projection`, `external`, `usecase` | an unusual query, a vendor mapping, a step | the same |
| `serves` | `interface` | a custom endpoint or format | the same |
| `shows` | `page`, `navigation`, `flow`, `messages` | a widget or a behavior of the page | the same |

The last five are the annotations, one per level. Treat every clause like a doc block in code: write one only when a reader would otherwise be confused.

| Write `describe` | Leave it out |
|---|---|
| The vendor call behind an operation: `POST /users/{id}/ban`, what a 404 means | An action whose `effect` already shows what it changes |
| A format the type cannot carry: "the id Clerk assigns, user_ followed by letters" | A field whose name and type say it all |
| Where to find a setting or secret | A use case whose steps read as its description |

## Writing one

Write the clause and a string after the head of a declaration (name, signature, `relevance`) and before its body, or at the end of a declaration without a body; an annotation follows `describe`:

```appling check
module accounts {
  external Clerk {
    op BanUser (id: String) describe "POST /users/{id}/ban on the Clerk backend API; 404 means the user is gone"
  }

  entity Account describe """
    Mirrors the Clerk user;
    @Account.clerk_id is the link between both.
  """ {
    clerk_id: String unique describe "The id Clerk assigns, user_ followed by letters"
    banned: Bool default false
  }

  action Ban on Account does "Signs the user out of every device" {
    effect {
      set banned = true
    }
  }

  query Banned from Account handles "Also asks @Clerk which accounts it banned" {
    where { banned }
  }
}
```

Every named element takes `describe`: `module`, `role`, `actor`, `tenant`, `enum` and its values, `value`, `entity`, fields, `event`, `action`, its inputs and errors, `machine`, `job`, `query`, `projection` and its fields, `external` and its operations, `usecase` and its parameters, `interface`, `page`, `navigation`, `flow`, `messages` and `migration`. Fields, parameters, errors, enum values, operations, `role`, `tenant` and `job` put it at the end.

An annotation on a declaration of another level is a syntax error. All six words stay valid as names, so a field may be called `does`.

## Text blocks

A text between `"""` and `"""` spans lines. Its value drops the line break after the opening quotes, the last line when it holds only the closing quotes, and the indentation all lines share; deeper indentation stays. `appling fmt` indents the lines one level deeper than the line the block starts on and puts the closing quotes on that line's level. A text block takes no escapes; a short `"..."` string takes the usual ones (`\"`, `\\`).

## Naming elements

`@Name` inside the text names an element the way a qualified name in a reference does: `@Account`, `@Account.clerk_id`, `@Clerk.BanUser`, and across modules `@sales.Order` for exported members. A name ends at the first character that is not a letter, digit, `_` or a `.` followed by a letter, so a sentence may end right after it. An `@` that continues a word, as in `ops@shop.example`, is text.

Each name is checked like a reference:

| Rule | Error |
|---|---|
| The name resolves to a visible element | `Unknown element "@Nope" in describe.` (or `in does.`, `in shows.`, ...) |
| The layer rules allow the reference, as for any [reference](overview.md#layers) | `behavior element Action may not reference application element External "@Clerk.BanUser".` |

A module's own description may name anything inside it. In the graph each name is a `uses` edge from the element, and [rename](../reference/edit-operations.md#rename) rewrites it.

## In the graph and in generated code

Each text is the property of its keyword on the element's [graph node](../reference/graph.md), in `props` and `data`. Each extension writes the texts as documentation into the code it generates for the element ([Django](../codegen/django.md#descriptions), [Ash](../codegen/ash.md#descriptions)). Each annotation also adds one registry task, left to the code: `implement what <Name> <keyword>: <text>`.

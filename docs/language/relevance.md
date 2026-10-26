---
title: Relevance
description: How much a declaration matters to what the application does, declared as a level and refined by the graph.
---

Not every declaration matters equally. In a quoting application the `Quote` entity and its `Accept` action are what the business runs on, while an audit log or an enum used by one field are details. Relevance records that difference, so tools can show the important parts first: the [IDE](../tools/ide.md#the-model-canvas) draws relevant declarations as larger circles in the middle of their row and keeps the peripheral ones small at the edges.

Every module and every top level declaration has a relevance score from 0 to 1. The graph computes it; a declared level puts it into a range.

## Levels

| Level | Score range | For |
|---|---|---|
| `core` | 0.7 to 1 | What the business runs on: its main records, the actions and use cases that carry its process |
| `supporting` | 0.35 to 0.7 | What the core needs: settings, lookups, integrations |
| `peripheral` | 0 to 0.35 | Housekeeping: logs, imports, internal tokens, tools around the application |

## Declaring a level

Write the level after the name and its clauses, before the opening brace, or at the end of a declaration without a body:

```appling check
module quotes {
  enum QuoteState {
    draft
    sent
    accepted
  }

  entity Quote core {
    state: QuoteState state default draft
  }

  action Send on Quote core {
  }

  action Accept on Quote core {
  }

  machine QuoteLifecycle on Quote.state core {
    transition draft -> sent via Send
    transition sent -> accepted via Accept
  }

  job Reminder every "0 9 * * *" run Send peripheral
}

module observability peripheral {
  entity Event {
    name: String
  }
}
```

`module`, `role`, `actor`, `tenant`, `enum`, `value`, `entity`, `event`, `action`, `machine`, `job`, `query`, `projection`, `external`, `usecase`, `interface`, `page`, `navigation`, `flow` and `messages` take a level. A module's level applies to its declarations and its nested modules, unless they declare their own: `observability.Event` above is `peripheral`.

`core`, `supporting` and `peripheral` stay valid as names.

## The computed score

Without a level, the score comes from the graph alone. Each declaration counts the other declarations that use it and the ones it uses, both lifted to their top level declaration, on a log scale against the busiest declaration of the workspace. An entity that many actions, queries and pages use scores high; an enum one field uses, or a value type nobody else reads, scores low.

A declared level maps that score into its range, so two `core` declarations still differ by how connected they are, and a `peripheral` declaration never outranks a `supporting` one. A module scores as its most relevant declaration.

Declare a level where the graph is wrong about the business: an action few things call but that is the reason the application exists, or a module of busy infrastructure that is not the point of it. `relevance(graph)` in [`@appling/model`](../reference/api.md#appling-model) returns the scores.

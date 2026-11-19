---
title: Seed to code
description: How far each model element is implemented, marked on every model line and on the inspector's canvas, and the registry tasks agent sessions finish.
---

The model is the seed, code generation the water, the code the plant. Every element of the model has an implementation state, computed from its [code references](references.md), the [registry](../codegen/registry.md) of each generated project and the last generation. The editor marks it on every model line, the [inspector](inspect.md) marks it on the canvas and lays out the registry tasks with the agent session that works on each.

## Implementation states

| State | When | Mark |
|---|---|---|
| implemented | The element has a current code reference, or the last generation wrote its code and the element has not changed since | solid outline |
| partial | An open registry task, next to code that exists (a reference, or generated code that is not complete), or a [stale](references.md#status) code reference: the element changed since its code was written | dashed outline |
| unimplemented | No code: no reference and nothing generated, or the element is new or changed since the last generation and has no reference | dotted outline |

A reference beats generated code: an element an agent linked to existing code counts as implemented even when no generator covers it. A member without code of its own, such as a field that its entity's class declares, is implemented as long as the generation that wrote its parent covered it and it has not changed since.

An element is **outstanding** when it is new or changed since the last generation of a target: generation would write it. A line you add to the model is outstanding and unimplemented as soon as you save it. Without targets in `appling.config.json` nothing is outstanding.

## Marks

- **Model lines.** The [Appling extension](editors.md#implementation-marks), in VS Code, marks the line each element starts on in the gutter; where several start on one line, the innermost wins. Hover a mark for the element and its state.
- **Canvas.** Each declaration on the [model canvas](inspect.md#the-model-canvas) shows its state in the outline of its chip, named in words when you point at it, rolled up with its members' (implemented or unimplemented when all are, partial otherwise); a module gets the roll up of its declarations. **Legend** at the bottom of the canvas explains the marks.
- **Inspector panel.** In VS Code the Inspector panel shows the state of the selected element with its open tasks and code.

## From the model to the code and back

- **To the code.** In VS Code, **Go to Implementation** (Ctrl+F12) on an element in a `.appling` file, or on a name that stands for one, opens its code; model lines with code get an **Open code** CodeLens, and the command **Appling: Open the code of this element** opens the code of the element at the cursor.
- **Back to the model.** **Go to Definition** (F12) on the name in an `@appling` marker opens the element in its `.appling` file. Each marked declaration has a CodeLens **Appling: sales.Order** above its first line; it selects the element on the inspector's canvas.

## Generate

The inspector does not generate. [`appling generate`](cli.md#generate) creates a target that was never generated, whole; its folder must be empty. [`appling generate --sync`](../codegen/sync.md) brings an existing project up to the model: its pending migration steps first, then a fresh generation merged three ways. What the generator cannot complete stays in the registry as tasks, and the inspector's marks and task board follow.

## Generation records

Generation, with `appling generate` and `appling generate --sync`, records:

- **Markers** in the code it wrote: an `@appling <qn> <fingerprint>` comment (see [Code references](references.md)) above the largest declaration among the lines each template step added, located again once every step ran (later steps may move them, such as imports added above); for a command step, above the first code of the files it declares it creates. A marker that would not mark that code, such as one inside a string, and code in files without comments (JSON) get none. Markers the element has elsewhere, such as code an agent marked, stay.
- **Fingerprints** of the generated elements per target, in `.appling/generation.json` of the current folder, the one `appling generate` runs in: a hash of each element's kind and properties. An element whose fingerprint differs from the recorded one is outstanding.

```json
{
  "build/shop": {
    "at": "2026-11-08T10:12:00.000Z",
    "fingerprints": { "sales.Order": "1f0c9a2e", "sales.Order.total": "8d41b7c0" }
  }
}
```

Code a framework command writes without declaring it (such as the files `startapp` fills) gets no marker of its own; its element counts as implemented through the generation record.

## Registry tasks and agent sessions

The [task board](inspect.md#the-task-board) of the inspector is where you follow them: **Tasks** in the bar under the model canvas lays every task over the canvas in order: **In progress** (claimed by an agent session), **Pending** (waiting, `partly written` when the element has code already) and **Done**, each in the order of the plan; a click on a task selects its element. Agent sessions pick them over MCP with [`registry_next`](ai.md#registry-tools): in a session it passes over tasks other sessions claimed and claims the task's element for the session, so the task shows the session's label in its colour; `registry_update` with `done`, or the last attempt, releases the claim.

## Existing code

For an application that existed before its model, an agent marks the code of the elements with `record_code_references` (the [reverse engineering skill](ai.md#reverse-engineering-skill) does it while it writes the model). Marked elements count as implemented; `implementation_status` lists what is still unimplemented or partial.

---
title: Seed to code
description: How far each model element is implemented, marked on every model line and on the canvas, generation of what changed from the IDE, and the registry tasks agent sessions finish.
---

The model is the seed, code generation the water, the code the plant. Every element of the model has an implementation state, computed from its [code references](references.md), the [registry](../codegen/registry.md) of each generated project and the last generation. The IDE marks it on every model line and on the canvas, offers to generate what changed, and lists the registry tasks with the agent session that works on each.

## Implementation states

| State | When | Mark |
|---|---|---|
| implemented | The element has a current code reference, or the last generation wrote its code and the element has not changed since | green dot, tag `implemented` |
| partial | An open registry task, next to code that exists (a reference, or generated code that is not complete) | amber dot, tag `partly implemented` |
| unimplemented | No code: no reference and nothing generated, or the element is new or changed since the last generation and has no reference | hollow dot and circle, tag `not implemented` |
| shifted | A code reference whose anchor moved; it still leads to the code, record it again | blue dot, tag `code moved` |
| broken | A code reference whose file or anchor is gone | red dot, tag `code missing` |

A reference beats generated code: an element an agent linked to existing code counts as implemented even when no generator covers it. A member without code of its own, such as a field that its entity's class declares, is implemented as long as the generation that wrote its parent covered it and it has not changed since.

An element is **outstanding** when it is new or changed since the last generation of a target: generation would write it. A line you add to the model is outstanding and unimplemented as soon as you save it. Without targets in `appling.config.json` nothing is outstanding.

## Marks

- **Model lines.** The editor marks the line each element starts on in the gutter; where several start on one line, the innermost wins. Hover a mark for the element and its state, click it to open the element's code. The [Appling extension](editors.md#implementation-marks) shows the same marks in VS Code and in Appling Desktop's Code OSS code view.
- **Canvas.** Each declaration on the [model canvas](ide.md#the-model-canvas) gets a dot and a tag in words in the colour of its state rolled up with its members' (broken or shifted when any is, implemented or unimplemented when all are, partial otherwise); a module gets the roll up of its declarations. **Legend** at the bottom of the canvas explains the marks.
- **Inspector.** The inspector shows the state of the selected element with its open tasks, **Open code** and **Generate**.

## From the model to the code and back

- **To the code.** Click a gutter mark, or **Open code** in the inspector. In Appling Desktop the code view opens the file at the element's lines; elsewhere the IDE shows the file read only in place of the model, with the lines marked, until **Back to the model**.
- **Back to the model.** In the Code OSS code view, each referenced range has a CodeLens **Appling: sales.Order** above its first line; it selects the element on the canvas. Model lines with code get an **Open code** CodeLens, and the command **Appling: Open the code of this element** does the same for the element at the cursor.

## Generate from the IDE

The **Code** tab of the side panel lists the targets of `appling.config.json` with their last generation and generates:

| Button | Generates |
|---|---|
| Generate N outstanding | The elements new or changed since the last generation |
| Generate *element* | The selected element with its members |
| Generate N checked | The elements checked in the outstanding list |
| Generate everything | The whole model |

After a model change adds outstanding elements, the canvas offers **Generate** for them; **Not now** hides the offer until the next change.

A run goes through every target, in a worker so the IDE stays responsive while the framework's commands run:

- A target that was never generated is created whole, as [`appling generate`](cli.md#generate) does, whatever the selection; its folder must be empty.
- An existing project is brought up to the model like [`appling generate --sync`](../codegen/sync.md): its pending migration steps first, then a fresh generation merged three ways, but only the files of the selected elements. Files are shared (one `models.py` holds every entity of an app), so every element whose files were all merged counts as generated too.
- What the generator cannot complete stays in the registry as tasks.

The tab shows the running generation: the planned steps, what was generated, the elements left with open tasks and the log. Each run also becomes a chapter of the [playbook](ide.md#the-playbook), written by **Code generation**: one step per target with the elements it plans, done with the files, references and merge result once generated, a step for the registry tasks it left, and the result.

## Generation records

Generation, from the IDE or with `appling generate` and `appling generate --sync`, records:

- **Code references** of the code it wrote, in `.appling/references.json`. For a template step, the lines it added to the file, located again in the final file (later steps may move them, such as imports added above); for a command step, the files it declares it creates. The references an element has elsewhere, such as code an agent linked, are kept.
- **Fingerprints** of the generated elements per target, in `.appling/generation.json` of the model folder: a hash of each element's kind and properties. An element whose fingerprint differs from the recorded one is outstanding.

```json
{
  "build/shop": {
    "at": "2026-11-08T10:12:00.000Z",
    "fingerprints": { "sales.Order": "1f0c9a2e", "sales.Order.total": "8d41b7c0" }
  }
}
```

Code a framework command writes without declaring it (such as the files `startapp` fills) gets no reference of its own; its element counts as implemented through the generation record.

## Registry tasks and agent sessions

The **Code** tab lists the open registry tasks of every target with their status, attempts, notes and what is missing. Agent sessions pick them over MCP with [`registry_next`](ai.md#registry-tools): in a session it passes over tasks other sessions claimed and claims the task's element for the session, so the task shows the session's label in its colour; `registry_update` with `done`, or the last attempt, releases the claim.

## Existing code

For an application that existed before its model, an agent links the code to the elements with `record_code_references` (the [reverse engineering skill](ai.md#reverse-engineering-skill) does it while it writes the model). Linked elements count as implemented; `implementation_status` lists what is still unimplemented, partial, shifted or broken.

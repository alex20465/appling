---
title: Code references
description: Where each model element is implemented in the application code, by file and line range, and how the references stay correct while the code changes.
---

Once a model is implemented, by a generated project and the work done on its registry, or by an existing application you derived the model from, each element lives somewhere in the code. A code reference records where: a file and a line range for a qualified name. A policy of `sales.Order`, for example, may live in `shop/sales/permissions.py` from line 12 to line 24.

References answer "where is this implemented" for you, for the [IDE](ide.md#the-inspector) and for an AI agent, without searching the code.

## The references file

The references of a workspace live in `.appling/references.json` in the model folder, next to the releases. They are keyed by qualified name; an element may have several references, one per place in the code:

```json
{
  "sales.Order": [
    { "file": "../shop/sales/models.py", "start": 14, "end": 31, "anchor": "class Order(models.Model):" }
  ]
}
```

| Field | Meaning |
|---|---|
| `file` | The code file, relative to the model folder |
| `start`, `end` | The first and the last line of the range, counted from 1 |
| `anchor` | The first line of the range without its indentation, recorded with it |

Paths are relative to the model folder, so the references work for a generated project inside the workspace (`build/shop/...`) as well as for an existing application next to it (`../shop/...`).

## Who records them

AI agents record references while they implement through the [MCP server](ai.md#reference-tools):

- The [registry skill](ai.md#registry-skill) records the lines of every element it finishes, before it marks the entry `done`.
- The [reverse engineering skill](ai.md#reverse-engineering-skill) records the code each element describes while it writes the model.

Both call `record_code_references`. It replaces the element's references, takes the first line of each range as its anchor, and refuses a missing file, a range outside the file, a range that starts on an empty line, or an element the model does not have.

## How they stay correct

Line numbers move as soon as someone edits the code above a range. Each reference therefore keeps its anchor, the line that declares the code, such as the class or the function. Whenever a reference is read, the anchor is looked up again:

| Status | When | Lines shown |
|---|---|---|
| `current` | The anchor is still on the recorded first line | The recorded range |
| `shifted` | The anchor is on another line; with several matches, the nearest one to the recorded line | The range moved to the anchor, same length |
| `broken` | The file or the anchor line is gone | The recorded range |
| `orphaned` | The model has no element of that name anymore, because it was renamed or removed | The recorded range |

A shifted reference still leads to the right code; record it again to store the new lines. A broken or orphaned reference needs someone to record it again or to remove it with an empty list.

## Look them up

On the command line, [`appling refs`](cli.md#refs) prints the references of an element and its members. Run it in the model folder, where `.appling/references.json` is:

```
$ appling refs sales.Order
../shop/sales/models.py:14-31 sales.Order
../shop/sales/permissions.py:12-24 sales.Order.policy[create,update,delete] (shifted)
```

In the IDE, the inspector lists the references of the selected element under **Code**; expand one to read its lines. An agent calls `code_references` with the qualified name.

## Check them

`appling refs --check` lists every reference that is not `current` and exits with 1 when there is one, so you can run it in CI after code or model changes:

```
$ appling refs --check
../shop/sales/models.py:16-33 sales.Order: shifted from 14-31
../shop/sales/views.py:40-52 sales.Archive: orphaned, no such element in the model
3 reference(s), 1 shifted, 0 broken, 1 orphaned
```

The `code_references` tool without a qualified name returns the same list, so an agent can record those references again.

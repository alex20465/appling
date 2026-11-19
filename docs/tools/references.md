---
title: Code references
description: Where each model element is implemented in the application code, marked by an @appling comment on the declaration, so the references stay correct while the code changes.
---

Once a model is implemented, by a generated project and the work done on its registry, or by an existing application you derived the model from, each element lives somewhere in the code. A code reference says where: the code itself names the element it implements in a comment or docstring line on its declaration. A policy of `sales.Order`, for example, may be the class `OrderPolicy` in `shop/sales/permissions.py`.

References answer "where is this implemented" for you, for your editor and for an AI agent, without searching the code.

## The marker

A marker is a line of its own in a comment or docstring, right above or inside the declaration it marks:

```
@appling <qualified name> <fingerprint>
```

The qualified name is an element, or the [sub-anchor](../reference/graph.md#sub-anchors) of a declaring line that is no element, such as a use case step (`sales.Checkout#step[2]`) or a `requires` (`sales.PlaceOrder#requires[1]`). The fingerprint is a short hash of the element as it was when the code was written; it is optional when you write a marker by hand.

Only the comment differs per language:

```python
# @appling sales.Order 75d03180
class Order(models.Model):
    total = models.DecimalField()

    def close(self):
        """Closes the order.

        @appling sales.Close 1c0e9a42
        """
```

```elixir
defmodule Shop.Sales.Order do
  @moduledoc """
  @appling sales.Order 75d03180
  """

  # @appling sales.PlaceOrder 9b2f61d0
  create :place do
    accept [:total]
  end
end
```

```go
// PlaceOrder places an order.
// @appling sales.PlaceOrder 9b2f61d0
func PlaceOrder(order Order) error {
```

A line that holds more than the marker, such as code that mentions `@appling`, is no marker.

## The range

The code a marker stands for is the declaration it belongs to, found by parsing the file with [tree-sitter](https://tree-sitter.github.io/) every time the references are read:

| Marker in | Marks |
|---|---|
| A comment | The declaration after it: the class, function, field, block or statement, with its decorators |
| A docstring or a module doc (`@moduledoc`) | The definition the docstring belongs to |
| An Elixir `@doc` or `@typedoc` | The function or type after it |

Python, Elixir, Go, Rust, TypeScript and JavaScript are parsed. In other code files with comments (YAML, TOML, Ruby, shell, Java, Kotlin, C and the like) the range is the first code line after the marker and every line indented deeper below it.

Since a marker moves with its code, adding or removing lines anywhere in the file changes nothing: no line numbers are stored.

## Where they are looked for

References are read from the code, every time:

- the git work tree that holds the model folder, or the model folder itself outside git,
- and every generated target configured in `appling.config.json`, even outside it (`../shop`).

Dependencies, build output and caches are skipped: hidden folders and `node_modules`, `_build`, `deps`, `target`, `__pycache__`, `venv`, `dist`, `out`, `build`, `coverage` and `vendor`.

## Who writes them

- [Generation](implementation.md#generation-records) writes a marker above the code each element got, with `appling generate` and `appling generate --sync`. Generating again renews the fingerprints.
- AI agents mark the code they implement through the [MCP server](ai.md#reference-tools): the [registry skill](ai.md#registry-skill) marks the code of every element it finishes, the [reverse engineering skill](ai.md#reverse-engineering-skill) the code each element describes.
- You write one by hand like any comment.

`record_code_references` writes the marker above the declaration that starts on a given line, renews the fingerprint of a marker the element already has there and removes its markers elsewhere. It refuses a missing file, a file outside the folders above, an empty line, a line that starts no declaration, or an element the model does not have.

## Status

| Status | When |
|---|---|
| `current` | The marker's fingerprint is the element's, or the marker has none |
| `stale` | The element changed since the code was written, or a [migration step](../language/migrations.md) renamed it since (the reference then has `marked`, the name in the marker) |
| `orphaned` | The model has no element or sub-anchor of that name, not even after the migration steps |

A stale reference still leads to the right code; check the code against the element and mark it again to renew the fingerprint. An orphaned one needs its marker removed or renamed.

## Look them up

On the command line, [`appling refs`](cli.md#refs) prints the references of an element, its members and its sub-anchors, run in the model folder:

```
$ appling refs sales.Order
../shop/sales/models.py:5-9 sales.Order
../shop/sales/models.py:9-9 sales.Order.status (stale)
```

In VS Code, **Go to Implementation** on an element in a `.appling` file opens its code, and **Go to Definition** on the name in a marker opens the element in the model (see [Implementation marks](editors.md#implementation-marks)); the Inspector panel of the [VS Code extension](vscode.md#the-panels) lists them too. An agent calls `code_references` with the qualified name.

## Check them

`appling refs --check` lists every reference that is not `current` and exits with 1 when there is one, so you can run it in CI after code or model changes:

```
$ appling refs --check
../shop/sales/models.py:9-9 sales.Order.status: stale, the element changed since the code was written
../shop/sales/models.py:13-14 sales.Archive: orphaned, no such element in the model
3 reference(s), 1 stale, 1 orphaned
```

The `code_references` tool without a qualified name returns the same list, so an agent can check that code and mark it again.

## Implementation state

References decide how far an element counts as implemented: the editor marks every model line and the [inspector](inspect.md) marks the canvas with it, see [Seed to code](implementation.md).

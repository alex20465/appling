---
title: Go
description: Generate plain Go packages for the domain and behavior layers of a model, ready to put behind your own storage and HTTP code.
---

The `@appling/codegen-go` extension writes one Go package per module, without a framework. It covers what Go can express without choosing libraries for you: types, invariants, derived fields, actions with their state transitions, errors and events. The rest becomes [registry](registry.md) tasks.

## Requirements

Go 1.22 or later on the `PATH`. Decimal and money values use [shopspring/decimal](https://github.com/shopspring/decimal), which setup adds with `go get`.

## Configuration

```json
{
  "generate": [
    { "extension": "@appling/codegen-go", "out": "build/shop" }
  ]
}
```

The Go module path is the project name: the `name` option, or the output folder's name. Each module becomes `internal/<module>`, so `sales` is imported as `shop/internal/sales`.

## Model to Go

| Model | Go |
|---|---|
| `enum` | a `string` type with one constant per value, such as `OrderStatusDraft` |
| `value`, `event` | a struct with JSON tags |
| `entity` | a struct with an `ID int64`, `New<Entity>()` setting the defaults, one method per derived field, and `Validate() error` checking the invariants |
| field types | `string`, `int64`, `bool`, `decimal.Decimal`, `time.Time`, `time.Duration`; enums and value types by name, entities as `*Entity`, lists as slices, optional fields as pointers |
| `action` | a function `<Action>(entity, inputs...) ([]any, error)`: preconditions return the declared errors, the state transition returns an error wrapping `ErrInvalidTransition` when the state does not allow it, effects change the record, and emitted events are returned |
| `machine` | transitions on an event become `<Machine>On<Event>(event) ([]any, error)` |
| `errors` | `var Err<Name> = errors.New(...)` |
| invariants, policies, transitions, preconditions | skipped tests in `<module>_test.go` |

Expressions are translated with their types: decimals use `Add`, `GreaterThanOrEqual` and friends, times use `Before`, `After` and `Add`, `sum(lines.map(l, l.amount))` becomes a loop, and `has(field)` checks the pointer.

This is the generated `Order` of the [example](../../examples/sales.appling):

```go
// Order is the entity sales.Order.
type Order struct {
	ID        int64        `json:"id"`
	Reference string       `json:"reference"`
	Customer  *crm.Account `json:"customer"`
	Lines     []Line       `json:"lines"`
	Status    OrderStatus  `json:"status"`
	CreatedAt time.Time    `json:"created_at"`
	PlacedAt  *time.Time   `json:"placed_at"`
	PaidAt    *time.Time   `json:"paid_at"`
}

// Total is the derived field sales.Order.total.
func (o *Order) Total() decimal.Decimal {
	return func() decimal.Decimal {
		total := decimal.Zero
		for _, l := range o.Lines {
			total = total.Add(l.Amount)
		}
		return total
	}()
}

// PlaceOrder is the action sales.PlaceOrder. It returns the events it emits.
func PlaceOrder(order *Order) ([]any, error) {
	var events []any
	if !(int64(len(order.Lines)) > 0) {
		return nil, ErrEmptyOrder
	}
	switch {
	case order.Status == OrderStatusDraft:
		events = append(events, OrderPlaced{Order: order})
		order.Status = OrderStatusPlaced
	default:
		return nil, fmt.Errorf("%w: PlaceOrder from %s", ErrInvalidTransition, order.Status)
	}
	order.PlacedAt = ptr(time.Now())
	return events, nil
}
```

## What becomes a task

Queries, projections, interfaces, pages, flows, messages, use cases, external systems, jobs and policies: they need storage, HTTP and scheduling decisions that the model leaves open. Also derived fields, defaults, preconditions, guards and effects that have no Go translation, such as expressions over `actor`, and effects that create records.

## Run the generated project

```sh
cd build/shop
go test ./...
```

`go test ./...` is also the command the registry stores for the [AI tools](../tools/ai.md).

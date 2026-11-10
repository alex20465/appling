---
title: Go
description: Generate plain Go packages for the domain and behavior layers of a model, ready to put behind your own storage and HTTP code.
---

The `@appling/codegen-go` extension writes one Go package per module, without a framework. It covers what Go can express without choosing libraries for you: types, invariants, derived fields, actions with their state transitions, errors and events, and access: actors, roles, the tenant and the policies as pure checks. The rest becomes [registry](registry.md) tasks.

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
| `action` | a function `<Action>(entity, inputs...) ([]any, error)`: preconditions return the declared errors, the state transition returns an error wrapping `ErrInvalidTransition` when the state does not allow it, effects change the record, and emitted events are returned. Once the model has a policy, it takes the actor first and returns an error wrapping `access.ErrForbidden` unless `Can<Action>` holds |
| `create` effect | the action builds the record with `New<Entity>()` and the given fields, checks `CanCreate<Entity>` once the model has a policy, and hands it to a `create<Entity> func(*Entity) error` parameter, which stores it |
| `emit` effect | an event struct with the given fields; an event whose required fields the effect does not give is a registry task |
| `create ... as name` | the same, with the record in the variable `name` for the effects after it |
| `for` effect | `for _, item := range order.Items { ... }` over the collection relationship |
| `update` effect | assigns the fields of the record the path leads to (`item.Product.Stock = ...`), checks `CanUpdate<Entity>` once the model has a policy, and hands it to an `update<Entity> func(*Entity) error` parameter; an optional path runs inside `if ... != nil` |
| `delete` effect | checks `CanDelete<Entity>` once the model has a policy and hands the record (`delete self`: the action's own) to a `delete<Entity> func(*Entity) error` parameter |
| `machine` | transitions on an event become `<Machine>On<Event>(event) ([]any, error)` |
| `errors` | `var Err<Name> = errors.New(...)` |
| `role`, `actor`, `tenant` | the `access` package, see [Access](#access) |
| `policy` | a function per policy and the `Can...` checks in `policies.go`, see [Policies](#policies) |
| invariants | a test in `<module>_test.go` per invariant that `Validate` checks: `valid<Entity>()` (`New<Entity>()` plus a sample value for every other required field) passes `Validate`, and the same record with one field set to a value the simulator proves to break the invariant fails with its label. Without such a value the violation case stays skipped as a registry task |
| transitions | a test in `<module>_test.go` per transition an action runs: `valid<Entity>()` in a `from` state goes to the `to` state through the action, and the action refuses a state no transition of it leaves with `ErrInvalidTransition`. Once the model has a policy, the test passes the first declared actor (`access.New<Actor>()`) the simulator proves the policies let run the action. The test stays skipped as a registry task when the simulator cannot prove that the preconditions and the guard hold for the record and the sample inputs, when an earlier transition of the action could take the record, when a policy involved has no Go translation, when no actor is proven allowed, or when the action, the entity and the machine are in different modules; so do transitions on an event |
| policies, preconditions | skipped tests in `<module>_test.go` |

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
func PlaceOrder(actor access.Actor, order *Order) ([]any, error) {
	var events []any
	if !CanPlaceOrder(actor, order) {
		return nil, fmt.Errorf("%w: PlaceOrder", access.ErrForbidden)
	}
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

## Access

[Roles, actors and the tenant](../language/access.md) become the package `internal/access` (`accessctl` when the model has a module named `access`). It imports none of the model's packages, so every module can import it without a cycle; that is why fields holding records hold their ID.

| Model | Go |
|---|---|
| `role` | a `Role` constant (`RoleClerk`) and `Is<Role>(actor Actor) bool`: the actor carries the role and the role's condition holds |
| `actor` | an `ActorType` constant (`ActorShopper`) and `New<Actor>()`, an `Actor` with the declared roles |
| actor fields, fields of the `is` entity | fields of `Actor`, pointers that are nil for actors without them; records as `*int64` IDs |
| `tenant` | `Actor.Tenant`, the ID of the tenant's entity, the `Tenanted` interface and `InTenant(actor, record)`; every entity that reaches the tenant's entity through single references gets `TenantID() (int64, bool)` |

A role or actor name that is not unique across modules is prefixed with its module path (`RoleCrmClerk`). An actor without a tenant (`Tenant` nil) acts across tenants. Actor fields typed with an enum or a value type are not generated yet; each is a registry task.

## Policies

Each policy becomes an unexported function in its module's `policies.go`, such as `orderPolicyRead(actor, order)`, translated like any expression: `actor.is(Clerk)` calls `access.IsClerk(actor)`, `actor.account` reads `actor.Account`, and `customer == actor.account` compares IDs with `access.Same`. The exported checks combine them with `&&`:

| Element | Checks |
|---|---|
| `entity` | `Can<Op><Entity>(actor, record)` for `Read`, `Create`, `Update` and `Delete`, false for an operation no policy grants; `Can<Op><Entity><Field>` for the fields a field policy narrows. A record in the tenant also needs `InTenant` |
| `action` | `Can<Action>(actor, record, inputs...)`: the update check of its entity and the action's own policies, false when there is neither; the action calls it first. An action without an entity that creates records and has no policy of its own checks `CanCreate<Entity>` on each record instead |
| `query` | `Can<Query>(actor, record, inputs...)`: the read check of its entity and the query's own policies, for the storage layer to apply per record |
| `usecase` | `Can<UseCase>(actor, params...)` from its own policies; the actions it runs check themselves |

Once the model has any policy, an operation that no policy covers is denied, the same rule as the [Django extension](django.md): an entity without policies gets checks that all return false, so its actions are forbidden too. A model without policies generates no checks, and its actions take no actor; only a [tenant](../language/access.md) then guards the actions on records in the tenant. Transitions on an event run without an actor and check nothing. A policy whose condition has no Go translation returns false, so it grants nothing until you write it; the registry lists it as a task.

```go
// CanPlaceOrder reports whether the actor may run sales.PlaceOrder, including the update check of sales.Order.
func CanPlaceOrder(actor access.Actor, order *Order) bool {
	return CanUpdateOrder(actor, order) && placeOrderPolicy(actor, order)
}

// placeOrderPolicy is the policy sales.PlaceOrder.policy[]: actor.is(Customer) && customer == actor.account
func placeOrderPolicy(actor access.Actor, order *Order) bool {
	return access.IsCustomer(actor) && access.Same(actor.Account, order.Customer.ID)
}
```

The tests of the policies stay skipped, with writing their bodies as registry tasks.

## What becomes a task

Queries, projections, interfaces, pages, flows, messages, use cases, external systems and jobs: they need storage, HTTP and scheduling decisions that the model leaves open. Queries and use cases still get their `Can...` check, and a query whose filter translates gets `In<Query>(record, inputs...) bool` in `queries.go`, which says whether a record belongs to its results, so the storage layer can apply it. Also derived fields, defaults, preconditions, guards, policies and effects that have no Go translation, such as `actor` outside a policy or a role, a `create`, `update` or `delete` effect that runs in a transition on an event, a `create` effect that leaves a required field without default unset, and an `emit` effect that leaves a required field of its event unset. The extension stays at the domain and behavior layers on purpose: generating the layers above means picking a storage, HTTP and scheduling stack, and that choice is deferred while Django and Ash catch up.

## Run the generated project

```sh
cd build/shop
go test ./...
```

`go test ./...` is also the command the registry stores for the [AI tools](../tools/ai.md).

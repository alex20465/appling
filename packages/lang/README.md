# @appling/lang

The Appling language: grammar, parser, scoping, validation and canonical printer, built on [Langium](https://langium.org).

Appling describes a business or web application as one validated model. The text is the canonical form, every element is identified by its qualified name, and each concept is defined once in the layer that owns it.

For the command line tool, see [`@appling/cli`](https://www.npmjs.com/package/@appling/cli).

## Example

```
module sales {
  export Order, OrderSummary

  enum OrderStatus {
    draft
    placed
  }

  entity Order {
    reference: String unique
    status: OrderStatus state default draft
    policy read { actor.is(Clerk) }
  }

  action PlaceOrder on Order {
    requires { reference != "" } else MissingReference
    errors MissingReference
  }

  machine OrderFlow on Order.status {
    transition draft -> placed via PlaceOrder
  }

  projection OrderSummary from Order {
    reference
    status
  }
}
```

## Language overview

| Layer | Declarations |
|---|---|
| Cross cutting | `module`, `export`, `role`, `actor`, `tenant`, `migration` |
| L1 Domain | `enum`, `value`, `entity` with fields, `invariant`, `policy` |
| L2 Behavior | `event`, `action`, `machine`, `job` |
| L3 Application | `query`, `projection`, `external`, `usecase` |
| L4 Interfaces | `interface <protocol>` with endpoints |
| L5 Experience | `page` with `list`, `detail`, `form`; `navigation`, `flow`, `messages` |

Expressions inside `{ ... }` use a subset of [CEL](https://cel.dev): `&&`, `||`, `!`, comparisons, `in`, arithmetic, member access, calls and list literals.

### Rules

- The keyword decides the layer. References follow the layer order: lower layers never reference higher ones, and interfaces and pages never reference each other.
- Interfaces and pages reach entity data only through projections.
- Other modules can only reference what a module lists in `export`, by its module path such as `crm.Account`.
- Only a `machine` changes a `state` field, and each state field has at most one machine.
- `migration` steps target elements by their path inside the module, as it was before the step: `rename Order.code -> reference`, `retype Order.total: Decimal -> Money`, `remove Order.legacy`. Renamed and retyped elements must exist, removed ones must not.

## API

```ts
import { URI } from 'langium';
import { NodeFileSystem } from 'langium/node';
import { createApplingServices, print, type Model } from '@appling/lang';

const { shared } = createApplingServices(NodeFileSystem);
const document = await shared.workspace.LangiumDocuments.getOrCreateDocument(URI.file('/path/to/sales.appling'));
await shared.workspace.DocumentBuilder.build([document], { validation: true });

console.log(document.diagnostics);
const model = document.parseResult.value as Model;
const canonical = print(model);
```

| Export | Purpose |
|---|---|
| `createApplingServices(context)` | Creates the Langium services with Appling scoping and validation |
| `print(root)` | Prints a parsed model in canonical form |
| `modulePath(module)` | The dotted path of a module, such as `a.b` |
| `LAYER_OF` | The layer of every top level declaration type |
| AST types and guards | `Model`, `Entity`, `isEntity` and the rest of the generated AST |

When you use the API directly, also install `langium` for `URI` and `NodeFileSystem`.

## License

MIT

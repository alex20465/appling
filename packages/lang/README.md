# @appling/lang

The Appling language: grammar, parser, scoping, validation and canonical printer, built on [Langium](https://langium.org).

Appling describes a business or web application as one validated model. The text is the canonical form, every element carries a stable id, and each concept is defined once in the layer that owns it.

For the command line tool, see [`@appling/cli`](https://www.npmjs.com/package/@appling/cli).

## Example

```
module sales #1m4nf {
  export Order, OrderSummary

  enum OrderStatus #11brq {
    draft #l3fpq
    placed #i2kjm
  }

  entity Order #1kzox {
    reference #j6why: String unique
    status #172vt: OrderStatus state default draft
    policy #ptbgb read { actor.is(Clerk) }
  }

  action PlaceOrder #ybpiu on Order {
    requires #vve7f { reference != "" } else MissingReference
    errors MissingReference #4snfc
  }

  machine OrderFlow #mltgu on Order.status {
    transition #1l1gk draft -> placed via PlaceOrder
  }

  projection OrderSummary #1d051 from Order {
    reference #19nga
    status #b5aqs
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
- Every element has a stable id that survives renames. Duplicates are errors.
- `migration` steps reference elements by stable id.

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
const canonical = print(model, () => '#new01');
```

| Export | Purpose |
|---|---|
| `createApplingServices(context)` | Creates the Langium services with Appling scoping and validation |
| `print(root, newId)` | Prints a parsed model in canonical form; `newId` supplies ids for elements that have none |
| `hasStableId(node)` | Whether an AST node type carries a stable id |
| AST types and guards | `Model`, `Entity`, `isEntity` and the rest of the generated AST |

When you use the API directly, also install `langium` for `URI` and `NodeFileSystem`.

## License

MIT

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
| L1 Domain | `enum`, `value`, `entity` (or `entity link` for a secondary entity such as a join record) with fields, `invariant`, `policy` |
| L2 Behavior | `event`, `action`, `machine`, `job` |
| L3 Application | `query`, `projection`, `external`, `usecase` |
| L4 Interfaces | `interface <protocol>` with endpoints |
| L5 Experience | `page` with `list`, `detail`, `form`; `navigation`, `flow`, `messages` |

A module or declaration may state its relevance to the business before its opening brace: `core`, `supporting` or `peripheral` (`entity Quote core { ... }`, `module observability peripheral { ... }`). A module's level applies to its members unless they state their own.

Expressions inside `{ ... }` use a subset of [CEL](https://cel.dev): `&&`, `||`, `!`, comparisons, `in`, arithmetic, member access, calls and list literals.

Expressions are typed. Names resolve against their position: the fields of the entity (and `this`) in invariants, entity policies, defaults and derived fields, plus the inputs inside actions, the machine's entity in guards, the query entity in `where`, the source in projections, the parameters in use cases. Everywhere, `actor` is the current actor, `now` is the current DateTime and `tenant` is the entity of the single declared tenant. A bare enum value such as `draft` takes its type from the other side of a comparison or from the field it is assigned to.

| Builtin | Type |
|---|---|
| `duration(String)` | Duration |
| `sum(list)`, `min(list)`, `max(list)` | the item type, numbers or Duration |
| `size(x)`, `x.size()` | Int, for lists and strings |
| `has(x)` | Bool |
| `list.map(x, expr)` | a list of the expression type |
| `list.filter(x, cond)`, `list.exists(x, cond)`, `list.all(x, cond)` | the list, Bool, Bool |
| `s.contains(t)`, `s.startsWith(t)`, `s.endsWith(t)`, `s.matches(t)` | Bool |
| `actor.is(Role or Actor)` | Bool |

Actors declare the fields that expressions read from `actor`:

```
actor human Shopper roles Customer {
  account: crm.Account
}
```

`actor.account` is valid when at least one actor declares `account`; it is optional when some actors do not.

### Rules

- The keyword decides the layer. References follow the layer order: lower layers never reference higher ones, and interfaces and pages never reference each other.
- Interfaces and pages reach entity data only through projections.
- Other modules can only reference what a module lists in `export`, by its module path such as `crm.Account`.
- Only a `machine` changes a `state` field, and each state field has at most one machine.
- Expressions must type check: conditions are Bool, values fit the field they are assigned to, `null` only fits optional fields, and calls in use cases pass the right number and types of arguments (an action on an entity takes the entity first, then its inputs).
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
| `printRange(node)` | The canonical text of one node in its document, with the gaps around it: `{ start, end, text }` |
| `buildSources(sources)` | Builds in memory sources keyed by URI as one validated workspace |
| `errorsOf(workspace)` | The error messages of a built workspace |
| `modulePath(module)` | The dotted path of a module, such as `a.b` |
| `LAYER_OF` | The layer of every top level declaration type |
| `ExpressionTyper` | Types expressions (`checkModel(model)`) and records `types`, `targets` (the element each name in an expression stands for) and `problems` |
| `show(type)`, `typeOfRef(ref)` | The display name of a type, and the type a `TypeRef` declares |
| `ApplingScopeProvider` | The scope provider; `lookup(container, type, name)` resolves a dotted name as a reference would |
| AST types and guards | `Model`, `Entity`, `isEntity` and the rest of the generated AST |

When you use the API directly, also install `langium` for `URI` and `NodeFileSystem`.

## Language server

`appling-language-server --stdio` starts a language server for any LSP client: diagnostics, completion, go to definition, references, rename, document symbols, hover (kind, qualified name, layer and doc comment) and formatting into the canonical form.

To embed it, for example over a websocket:

```ts
import { startLanguageServer } from 'langium/lsp';
import { NodeFileSystem } from 'langium/node';
import { createApplingLspServices } from '@appling/lang/lsp';

startLanguageServer(createApplingLspServices({ connection, ...NodeFileSystem }).shared);
```

| Export of `@appling/lang/lsp` | Purpose |
|---|---|
| `createApplingLspServices(context)` | The Appling services with Langium's LSP services |
| `ApplingFormatter`, `ApplingHoverProvider`, `ApplingLspModule` | The Appling specific LSP services |

## License

MIT

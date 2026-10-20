# Appling

Appling is a declarative language that describes a business or web application as one validated model. The model covers what exists, what can happen, how capabilities are organized and exposed, and how people interact with them.

The text is the canonical source of truth. Parsed and linked, it becomes a semantic graph that tools can validate, visualize with semantic zoom, simulate and edit with AI. Code generation is a possible future feature.

```
module sales {
  export Order

  enum OrderStatus {
    draft
    placed
  }

  entity Order {
    reference: String unique
    status: OrderStatus state default draft
  }

  action PlaceOrder on Order {
    requires { reference != "" }
  }

  machine OrderFlow on Order.status {
    transition draft -> placed via PlaceOrder
  }
}
```

## Model structure

| Layer | Describes | Declarations |
|---|---|---|
| Cross cutting | Modules, identity and access, evolution | `module`, `role`, `actor`, `tenant`, `migration` |
| L1 Domain | What exists | `enum`, `value`, `entity`, `invariant`, `policy` |
| L2 Behavior | What can happen | `event`, `action`, `machine`, `job` |
| L3 Application | How capabilities are organized | `query`, `projection`, `external`, `usecase` |
| L4 Interfaces | How programs reach them | `interface` |
| L5 Experience | How people reach them | `page`, `navigation`, `flow`, `messages` |

Each concept is defined once in the layer that owns it. References only point down the layers, interfaces and pages reach data only through projections, and modules only see what other modules export. Every element is identified by its qualified name, such as `sales.Order.status`, and renames are recorded as `migration` steps.

The full design is in [concept.md](concept.md).

## Packages

| Package | Purpose |
|---|---|
| [`@appling/cli`](packages/cli) | The `appling` command: `check` validates models, `fmt` writes the canonical form |
| [`@appling/lang`](packages/lang) | The language: grammar, scoping, validation and canonical printer, built on [Langium](https://langium.org) |

```sh
npx @appling/cli check models
npx @appling/cli fmt models
```

## Development

Developed with Node.js 24. pnpm is pinned through `packageManager` in `package.json`. Run `corepack enable` once so `pnpm` uses the pinned version.

```sh
pnpm install
pnpm build            # generates the parser, then compiles both packages
pnpm check examples   # validates the sample models
pnpm fmt examples     # canonical formatting
```

`check` and `fmt` run the built CLI, so rebuild after changing the grammar or sources.

```
packages/lang     grammar (src/appling.langium), scoping, validator, printer
packages/cli      the appling command
examples          sample models that reference each other across modules
concept.md        language design and rules
TODO.md           planned tooling
```

## Roadmap

Planned tooling, such as reverse engineering, an editor with AI support, a changelog for migrations, sync with implementations and IDE support, is listed in [TODO.md](TODO.md).

## License

MIT

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Appling: a declarative DSL (`.appling` files) that models a business application across five layers (Domain, Behavior, Application, Interfaces, Experience) plus cross cutting concepts (modules, roles, actors, tenants, migrations). The text is the canonical source of truth; the end goal is a validated semantic graph for zoomable visualization, simulation and AI editing; code generation is a possible future feature. `concept.md` is the design spec (layer ownership, reference rules, narrowing, identity by qualified name) and is the authority when grammar or validation decisions are unclear. `TODO.md` lists planned tooling.

## Commands

pnpm workspace (`packages/*`), TypeScript 7, Langium 4.4. There is no test suite or linter.

```sh
pnpm install
pnpm build                  # langium generate + tsc in packages/lang, then tsc in packages/cli
pnpm check [paths...]       # validate .appling files (default: current dir, recursive)
pnpm fmt [paths...]         # rewrite files into canonical form
pnpm --filter @appling/lang build   # rebuild only the language after grammar changes
```

`check` and `fmt` run the built CLI (`packages/cli/out/main.js`), so rebuild after any source change. Use `pnpm check examples` to verify changes against the sample models; `examples/sales.appling` and `examples/crm.appling` reference each other across modules.

## Architecture

- `packages/lang` (`@appling/lang`): the language. `src/appling.langium` is the grammar; `langium generate` writes `src/generated/` (gitignored, never edit). `index.ts` exports the services factory, the printer and the generated AST.
- `packages/cli` (`@appling/cli`): the `appling` binary with two commands, `check` (build with validation, print diagnostics) and `fmt` (requires a syntax error free parse, then prints canonically and writes back). All given files load as one workspace so cross file module references resolve. Exit codes: 0 no errors, 1 `check` errors or `fmt` skipped a file, 2 unknown command. `fmt` must be idempotent: a second run changes nothing.

Each package has a user facing `README.md` (published to npm) documenting the CLI usage and exit codes, the language overview, its rules and the public API. Keep them in sync when changing CLI behavior, grammar keywords, validation rules or exports from `index.ts`.

Key mechanics that span several files:

- **Identity and migrations.** Elements are identified by their qualified name; there are no separate ids. Migration steps (`rename`/`retype`/`remove`) target a path inside their module as it was before the step. `checkMigration` replays the later steps of the same module (in declaration order) to find where that path lives now, then requires it to exist (rename, retype) or not exist (remove).
- **Scoping** (`appling-scope.ts`). Inside a module, nested elements are visible by dotted path (`Order.status`). Across modules (and files) only members listed in `export` are visible, by module path (`sales.Order`, nested modules `a.b.X`). The scope provider special cases `picks` (fields of the referenced projection), `sort` (fields of the query entity), `set` (fields of the action's entity or the machine's entity) and error handlers (errors of the called action or external op).
- **Layer rules** (`appling-validator.ts`). `LAYER_OF` maps every top level member type to a layer; `checkLayerReferences` walks every cross reference and applies `isAllowed`, which encodes the reference DAG from `concept.md` section 2.3. A new member type must be added to `LAYER_OF`.
- **Expressions** are a CEL subset parsed into plain AST nodes. Names inside expressions are strings, not cross references, so they are neither resolved nor type checked yet.
- **Canonical printer** (`appling-printer.ts`). Walks the CST leaves and decides every gap between tokens, keeping comments. Layout is driven by the `BLOCKS` (node types whose `{` opens an indented block) and `CLAUSES` (keywords that start their own line inside a block) sets; new block or clause constructs in the grammar must be registered there or they print inline.

Grammar conventions: keywords that should remain valid as names (fields like `state`, `order`) must also be listed in the `Ident` rule. References use `[Type:QualifiedName]` except for local lookups (`[Field:Ident]`, `[ErrorDecl:Ident]`) that the scope provider resolves.

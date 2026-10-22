# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Appling: a declarative DSL (`.appling` files) that models a business application across five layers (Domain, Behavior, Application, Interfaces, Experience) plus cross cutting concepts (modules, roles, actors, tenants, migrations). The text is the canonical source of truth; the end goal is a validated semantic graph for zoomable visualization, simulation and AI editing; code generation produces a draft project for a target framework through installable extensions (Django and Ash first). `docs/concept.md` is the design spec (layer ownership, reference rules, narrowing, identity by qualified name) and is the authority when grammar or validation decisions are unclear. `docs/ROADMAP.md` lists the planned packages, phases and decisions.

## Commands

pnpm workspace (`packages/*`), TypeScript 7, Langium 4.4, vitest 5. There is no linter. Use the pinned pnpm (`corepack pnpm`); a global pnpm 8 cannot install into this workspace.

```sh
pnpm install
pnpm build                  # langium generate + tsc in packages/lang, then tsc in packages/cli
pnpm check [paths...]       # validate .appling files (default: current dir, recursive)
pnpm fmt [paths...]         # rewrite files into canonical form
node packages/cli/out/main.js graph [paths...]   # semantic graph as JSON
pnpm test                   # vitest over packages/*/test (run langium generate or build first)
pnpm --filter @appling/lang build   # rebuild only the language after grammar changes
```

`check` and `fmt` run the built CLI (`packages/cli/out/main.js`), so rebuild after any source change. Tests live in `packages/<pkg>/test/`; `packages/lang/test/workspace.ts` builds in memory sources as one workspace. Every validation rule has a negative fixture in `validation.test.ts`; add one with each new rule. Use `pnpm check examples` to verify changes against the sample models; `examples/sales.appling` and `examples/crm.appling` reference each other across modules.

## Architecture

- `packages/lang` (`@appling/lang`): the language. `src/appling.langium` is the grammar; `langium generate` writes `src/generated/` (gitignored, never edit). `index.ts` exports the services factory, the printer and the generated AST.
- `packages/model` (`@appling/model`): the semantic graph. `buildGraph(models, services)` turns resolved models into serializable nodes (qualified name, kind, layer, zoom level, module, props) and edges (`contains`, `uses` for names in expressions, plus one per cross reference, kind = reference property, `decl` becomes `type`); `dependencies(graph)` aggregates module to module edges. Only the kinds in `NAMED` and those with a `keyOf` key become nodes; every other AST node folds into its element's props as canonical text, and its references become edges of that element. A new grammar element kind must be added to one of the two.
- `packages/landing` (`@appling/landing`, private): the Astro 7 + Tailwind 4 landing site. Pages live in `src/pages/`, share `src/layouts/Layout.astro` (header, footer) and the design tokens in `src/styles/global.css`. The design source for every page is the Design canvas https://claude.ai/artifact/KLixzPpo9HLrXJG21jWkVC (one artboard per page, built on the Appling design system); implement new pages from their artboard there.
- `packages/cli` (`@appling/cli`): the `appling` binary with three commands, `check` (build with validation, print diagnostics), `fmt` (requires a syntax error free parse, then prints canonically and writes back) and `graph` (validated build, then the semantic graph as JSON on stdout; diagnostics go to stderr). All given files load as one workspace so cross file module references resolve. Exit codes: 0 no errors, 1 `check` or `graph` errors or `fmt` skipped a file, 2 unknown command. `fmt` must be idempotent: a second run changes nothing.

Each package has a user facing `README.md` (published to npm) documenting the CLI usage and exit codes, the language overview, its rules and the public API. Keep them in sync when changing CLI behavior, grammar keywords, validation rules or exports from `index.ts`.

Key mechanics that span several files:

- **Identity and migrations.** Elements are identified by their qualified name; there are no separate ids. Migration steps (`rename`/`retype`/`remove`) target a path inside their module as it was before the step. `checkMigration` replays the later steps of the same module (in declaration order) to find where that path lives now, then requires it to exist (rename, retype) or not exist (remove).
- **Scoping** (`appling-scope.ts`). Inside a module, nested elements are visible by dotted path (`Order.status`). Across modules (and files) only members listed in `export` are visible, by module path (`sales.Order`, nested modules `a.b.X`). The scope provider special cases `picks` (fields of the referenced projection), `sort` (fields of the query entity), `set` (fields of the action's entity or the machine's entity) and error handlers (errors of the called action or external op).
- **Layer rules** (`appling-validator.ts`). `LAYER_OF` maps every top level member type to a layer; `checkLayerReferences` walks every cross reference and applies `isAllowed`, which encodes the reference DAG from `docs/concept.md` section 2.3. A new member type must be added to `LAYER_OF`.
- **Expressions** (`appling-types.ts`) are a CEL subset parsed into plain AST nodes. Names inside expressions are strings, not cross references; `ExpressionTyper` resolves them per position (`contextOf`), types every root expression and call, and records `targets` (the element each name stands for). The validator reports its problems; the graph turns targets into `uses` edges; renames must follow them. `actor.is(x)` resolves through `ApplingScopeProvider.lookup`. A new construct that holds an expression needs a branch in `contextOf`, or its expressions are not typed.
- **Canonical printer** (`appling-printer.ts`). Walks the CST leaves and decides every gap between tokens, keeping comments. Layout is driven by the `BLOCKS` (node types whose `{` opens an indented block) and `CLAUSES` (keywords that start their own line inside a block) sets; new block or clause constructs in the grammar must be registered there or they print inline.

Grammar conventions: keywords that should remain valid as names (fields like `state`, `order`) must also be listed in the `Ident` rule. References use `[Type:QualifiedName]` except for local lookups (`[Field:Ident]`, `[ErrorDecl:Ident]`) that the scope provider resolves.

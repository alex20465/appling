# Roadmap

The goal: an Appling IDE that visualizes the application model at every zoom level, edits it visually, in text and through AI, records migrations once a release exists, and generates a draft project for a target framework through installable extensions.

Every one of these tools reads the same resolved semantic graph and changes it through the same edit operations. That graph is built first; everything else depends on it.

## Decisions

- **Code generation** produces a draft project once. A task registry records what was generated and what is still open. No placeholders inside the code. Regeneration (Appling Sync) builds on the registry later.
- **AI** is provider agnostic. `@appling/ai` is an MCP server usable by any MCP client, plus a model adapter inside the IDE, based on an existing multi provider library (candidate: Vercel AI SDK).
- **Order:** foundation first, then the IDE track and the code generation track in parallel.
- **Releases** are graph snapshots written by `appling release <version>` into `.appling/releases/`.

## Phase 1: Foundation

`@appling/lang`, `@appling/model`

- [ ] Semantic graph: plain, serializable nodes (qualified name, kind, layer, module, props) and typed edges. Zoom aggregation, such as module to module dependencies, is computed.
- [ ] Edit operations: add, rename, retype, remove, set attribute. Each becomes a minimal text edit through the printer and is rejected if the result fails validation.
- [ ] Releases: `appling release <version>` writes a graph snapshot. Edits to L1 elements that exist in the latest snapshot append migration steps automatically.
- [ ] LSP: `@appling/lang/lsp` export with Langium's LSP services.
- [ ] Expression typing: resolve names and types inside expressions where possible. Unresolved expressions become registry tasks during code generation.

Done when the CLI can dump the graph of `examples/` and an edit operation survives `fmt` idempotently.

## Track A: IDE

`@appling/ide`, `@appling/ai`

- [ ] A1 Read only IDE: `npx @appling/ide` starts a local server on the workspace. Browser UI with a text editor backed by the LSP, the zoomable graph at the three levels of `concept.md` section 4, and selection synced between text and graph. Layout lives in `.appling/layout.json`, outside the model.
- [ ] A2 Editing: edit elements and attributes in the graph through the edit operations. Migration entries appear when a release exists.
- [ ] A3 AI: MCP server exposing check, graph query, edit operations and the registry. Provider adapter and chat panel in the IDE. AI changes pass validation and are shown as reviewable diffs.

## Track B: Code generation

`@appling/codegen`, `@appling/codegen-django`, `@appling/codegen-ash`

An extension is a map, not a generator. For every node kind it declares one or more steps:

| Step | Does | Django | Ash |
|---|---|---|---|
| `command` | runs the framework's own CLI | `django-admin startproject`, `manage.py startapp` | `mix igniter.new --install ash`, `mix ash.gen.resource` |
| `template` | writes or patches a file where no command exists | invariants as `Meta.constraints`, django-fsm transitions | policies, `ash_state_machine` (Igniter patching) |
| `task` | adds a registry entry for the AI or a human | derived logic, complex preconditions, test bodies | same |

Steps chain per node, for example `entity`: command for the base, template for invariants, task for the rest.

The core reads the graph, asks the map for the steps of every node, orders them by dependency (modules, then entities, then actions), checks the toolchain prerequisites the extension declares, runs the steps and writes the registry. `appling generate --plan` prints the plan without running it.

The registry (`.appling/tasks.json` in the generated project) holds one entry per qualified name: status (`generated`, `partial`, `todo`, `done`), the steps and files that produced it, and what is missing with its model context (expression source, preconditions, errors, related nodes). Every graph node must have an entry, so the registry is also the coverage report and the AI work queue.

Extensions are configured in `appling.config.json` by package name. Third party extensions are named `appling-codegen-*` or `@scope/appling-codegen-*`, have a peer dependency on `@appling/codegen` and depend only on `@appling/model` types, never on the Langium AST.

- [ ] B1 Core: plan, step runner, map contract, registry, prerequisite checks, `appling generate`.
- [ ] B2 Django and Ash maps for L1: entities, enums, value types, invariants, policies.
- [ ] B3 Django and Ash maps for L2 to L4: actions, state machines, events, jobs, queries, projections, use cases, interfaces.
- [ ] B4 Tests: test skeletons for invariants, preconditions, transitions and policies; test bodies are registry tasks.
- [ ] B5 Registry skill in `@appling/ai`: picks open entries, implements them, runs the related tests, marks them done.
- [ ] B6 Migrations through `makemigrations` and `mix ash.codegen`, fed with Appling `rename` and `retype` steps so they are not guessed as remove plus add.

## Order

1. Phase 1
2. A1 in parallel with B1 and B2
3. A2 and A3 in parallel with B3 and B4
4. B5 and B6

## Packages

| Package | Status | Depends on | Contents |
|---|---|---|---|
| `@appling/lang` | exists | langium | grammar, scoping, validation, printer, expression typing, `/lsp` export |
| `@appling/model` | new | lang | semantic graph, edit operations, release snapshots, migration steps |
| `@appling/cli` | exists | lang, model, codegen | `check`, `fmt`, `release`, `generate` |
| `@appling/ide` | new | lang, model, ai | local web IDE |
| `@appling/ai` | new | model | MCP server, provider adapter, skills |
| `@appling/codegen` | new | model | plan, step runner, map contract, registry |
| `@appling/codegen-django` | new | codegen | Django map and templates |
| `@appling/codegen-ash` | new | codegen | Ash map and templates |

## Later

- [ ] VS Code extension on top of `@appling/lang/lsp`
- [ ] Appling Sync: regenerate code from the model using the registry
- [ ] Reverse engineering: AI skill in `@appling/ai` that derives an Appling model from an existing application
- [ ] More targets (Go, Rust) as extensions

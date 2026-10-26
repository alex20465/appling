---
title: API
description: The public TypeScript API of the Appling packages, export by export, with one usage example per package.
---

Every tool in Appling is built on six public packages. Use them to build your own checks, reports, editors, generators or agents. All packages are ES modules for Node 24.

| Package | Purpose |
|---|---|
| `@appling/lang` | Grammar, parser, scoping, validation, expression typing, canonical printer |
| `@appling/lang/lsp` | The language server services |
| `@appling/model` | Semantic graph, edit operations, releases |
| `@appling/codegen` | Code generation core: plans, registry, migrations |
| `@appling/ai` | Workspace access for AI, MCP server, chat |
| `@appling/viz` | Model views, the canvases of the IDE and the visualization window |

## Language: @appling/lang

Parse and validate files with the Langium services. Install `langium` too, for `URI` and `NodeFileSystem`.

```ts
import { URI } from 'langium';
import { NodeFileSystem } from 'langium/node';
import { createApplingServices, print, type Model } from '@appling/lang';

const { shared } = createApplingServices(NodeFileSystem);
const document = await shared.workspace.LangiumDocuments.getOrCreateDocument(URI.file('/path/to/sales.appling'));
await shared.workspace.DocumentBuilder.build([document], { validation: true });

console.log(document.diagnostics);
const canonical = print(document.parseResult.value as Model);
```

| Export | Purpose |
|---|---|
| `createApplingServices(context)` | Creates the Langium services with Appling scoping and validation; returns `{ shared, Appling }` |
| `ApplingModule`, `ApplingServices` | The Appling service module and the services type |
| `buildSources(sources)` | Builds in memory sources `{ [uri]: text }` as one validated workspace; returns a `Workspace` (`{ documents, services }`) |
| `errorsOf(workspace)` | The error messages of a built workspace |
| `print(root)` | A parsed model in canonical form, the text `appling fmt` writes |
| `printRange(node)` | The canonical text of one node in its document with the gaps around it: `{ start, end, text }` (`PrintedRange`) |
| `modulePath(module)` | The dotted path of a module, such as `a.b` |
| `projectionSourceEntity(projection)` | The entity behind a projection, also when its source is a query |
| `ApplingScopeProvider` | The scope provider; `lookup(container, type, name)` resolves a dotted name as a reference would |
| `ExpressionTyper` | Types expressions: `checkModel(model)` fills `types`, `targets` (the element each name stands for) and `problems` (`Problem[]`) |
| `show(type)`, `typeOfRef(ref)` | The display name of a `Type`, such as `Money?`, and the `Type` a `TypeRef` declares |
| `LAYER_OF`, `Layer` | The layer of every top level declaration type |
| AST types and guards | `Model`, `Module`, `Entity`, `isEntity` and the rest of the generated AST |

## Language server: @appling/lang/lsp

```ts
import { startLanguageServer } from 'langium/lsp';
import { NodeFileSystem } from 'langium/node';
import { createApplingLspServices } from '@appling/lang/lsp';

startLanguageServer(createApplingLspServices({ connection, ...NodeFileSystem }).shared);
```

| Export | Purpose |
|---|---|
| `createApplingLspServices(context)` | The Appling services with Langium's LSP services; returns `{ shared, Appling }` |
| `ApplingLspModule` | The Appling specific LSP services: formatter and hover |
| `ApplingFormatter` | Formats a whole document into canonical form |
| `ApplingHoverProvider` | Hover with kind, qualified name, layer and doc comment |

`@appling/lang/monarch` exports the Monarch grammar as default. Both are described in [Editors](../tools/editors.md).

## Graph and edits: @appling/model

Build the semantic graph of in memory sources and apply an edit:

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { URI } from 'langium';
import { buildSources, type Model } from '@appling/lang';
import { applyEdit, buildGraph, dependencies } from '@appling/model';

const uri = URI.file(resolve('models/shop.appling')).toString();
const sources = { [uri]: readFileSync('models/shop.appling', 'utf8') };

const { documents, services } = await buildSources(sources);
const graph = buildGraph(documents.map(d => d.parseResult.value as Model), services);
console.log(dependencies(graph)); // [{ from: 'sales', to: 'crm', count: 1 }]

const result = await applyEdit(sources, { op: 'add', parent: 'sales.Order', source: 'note: Text?' });
console.log(result.ok ? result.edits : result.errors);
```

| Export | Purpose |
|---|---|
| `buildGraph(models, services)` | Nodes and edges of resolved models, in document order |
| `dependencies(graph)` | Module to module dependencies with the number of references behind each |
| `isElement(node)` | Whether an AST node becomes a graph node |
| `qualifiedNames(models)` | A map from every element AST node to its qualified name, in document order |
| `parentElement(node, qns)` | The nearest element containing an AST node |
| `Graph`, `GraphNode`, `GraphEdge`, `Dependency`, `Level`, `ExprData`, `TypeData` | The graph types, see [Semantic graph](graph.md) |
| `applyEdit(sources, operation, { release })` | Applies one edit operation, see [Edit operations](edit-operations.md) |
| `EditOperation`, `EditResult`, `TextEdit` | The edit types |
| `writeRelease(root, version, graph)` | Writes `<root>/.appling/releases/<version>.json` and returns its path; throws for an invalid or existing version |
| `readReleases(root)`, `latestRelease(releases)` | All releases of a workspace, and the one with the highest version |
| `releasesDir(root)` | `<root>/.appling/releases` |
| `migrationBlockName(version)` | The migration block for steps after a release: `1.0.0` gives `since_v1_0_0` |
| `Release` | `{ version, created, graph }` |
| `recordReferences(root, qn, ranges)` | Replaces the [code references](../tools/references.md) of one element in `<root>/.appling/references.json` and returns them; throws for a missing file, a range outside it or one that starts on an empty line |
| `readReferences(root)`, `resolveReferences(root, graph?)` | The stored references by qualified name, and every reference with its status and where it is now; with a graph, references to elements it lacks are `orphaned` |
| `REFERENCES`, `CodeReference`, `References`, `ResolvedReference`, `ReferenceStatus` | `.appling/references.json` and the reference types |
| `relevance(graph)` | The [relevance](../language/relevance.md) of every module and top level declaration, from 0 to 1, by qualified name |
| `relevanceLevel(score)`, `RELEVANCE_LEVELS`, `RelevanceLevel` | The level a score falls in, and the score range of each level |
| `findApplingFiles(path)` | The `.appling` files at a path, searching folders recursively and skipping hidden folders and `node_modules` |

`@appling/model/simulator` and `@appling/model/relevance` export the simulator and the relevance functions without the rest of the package, so a browser bundle can import them.

## Code generation: @appling/codegen

Plan generation for a graph without running it, as `appling generate --plan` does:

```ts
import { describe, loadExtension, plan } from '@appling/codegen';

const extension = await loadExtension('@appling/codegen-django', '.');
const result = plan(graph, extension, 'shop');
for (const { node, step } of result.steps) console.log(node, describe(step));
console.log(result.entries.filter(e => e.status !== 'generated').map(e => e.qn));
```

Configuration and extensions:

| Export | Purpose |
|---|---|
| `readConfig(root)` | `<root>/appling.config.json` as `Config`, or `{}` |
| `loadExtension(name, root)` | Imports an extension package, resolved from `root`, and returns its default export |
| `Config`, `Target`, `CONFIG` | The configuration types and the file name |
| `CodegenExtension` | The extension contract: `name`, `prerequisites`, `test`, `setup`, `steps`, `migrate` |
| `Step`, `CommandStep`, `TemplateStep`, `TaskStep` | The three step kinds |
| `MapContext`, `Prerequisite` | What an extension gets per node, and a tool it needs |

Planning and running:

| Export | Purpose |
|---|---|
| `plan(graph, extension, name, options)` | The ordered steps and one registry entry per node (`Plan`) |
| `describe(step)` | A one line description of a step, as `--plan` prints it |
| `mapContext(graph, name, options)` | The `MapContext` passed to extensions |
| `checkPrerequisites(prerequisites)` | One message per missing tool |
| `runPlan(plan, out, log)` | Runs the steps into `out` and writes the registry |
| `runSteps(steps, out, log)` | Runs steps without writing a registry |
| `PROJECT` | The node name of setup steps, `(project)` |
| `PlannedStep`, `Plan` | A step with its node, and the result of `plan` |

Registry:

| Export | Purpose |
|---|---|
| `readRegistry(out)`, `writeRegistry(out, registry)` | `<out>/.appling/tasks.json` |
| `Registry`, `RegistryEntry`, `Missing`, `Status` | The registry types, see [Configuration](configuration.md#tasksjson) |
| `REGISTRY` | The registry path inside a project, `.appling/tasks.json` |

Migrations:

| Export | Purpose |
|---|---|
| `pendingChanges(graph, applied, stamp)` | The model's migration steps not in `applied`, with each element's qualified name before and now (`MigrationChange[]`) |
| `planMigrations(graph, extension, name, options, out, changes)` | Asks the extension's `migrate` for the steps of every change |
| `runMigrations(out, plan, changes, log)` | Runs them, adds the tasks to the registry and records the changes as applied |
| `readApplied(out)` | The ids in `<out>/.appling/migrations.json` |
| `MigrationChange`, `ProjectFiles`, `APPLIED` | The change type, read access to the project for extensions, and the applied file path |

How to write an extension is described in [Writing extensions](../codegen/extensions.md).

## AI: @appling/ai

Work with a workspace folder the way the MCP tools do:

```ts
import { Project, queryGraph } from '@appling/ai';

const project = new Project('models');
console.log(await project.check()); // [] when valid
console.log(queryGraph(await project.graph(), { kind: 'Entity' }));

const result = await project.edit({ op: 'rename', target: 'sales.Order.total', name: 'amount' });
if (result.ok) project.write(result.sources);
```

Workspace:

| Export | Purpose |
|---|---|
| `Project` | A workspace folder: `sources()`, `check()`, `graph()`, `source(qn)`, `edit(operation)` with the latest release, `write(sources)`, and the registry methods `targets()`, `nextTask(target)`, `updateTask(qn, status, note, target)`, `runTests(target)`, and `references(qn?)`, `recordReferences(qn, ranges)` for the code references |
| `queryGraph(graph, query)` | What the `graph_query` tool returns |
| `MAX_ATTEMPTS` | Attempts after which a registry entry stops coming back, `3` |
| `Sources` | `{ [uri]: text }` |

Tools and MCP:

| Export | Purpose |
|---|---|
| `MODEL_TOOLS`, `AUTHORING_TOOLS`, `REGISTRY_TOOLS`, `REFERENCE_TOOLS`, `Tools` | The tool definitions: description, zod input shape and `run(context, input)` |
| `operationSchema` | The zod schema of an edit operation |
| `ToolContext`, `diskContext(project)`, `ProposalContext` | Where tools read and write: the files on disk, or a working copy that collects operations |
| `createMcpServer(root, { visualizer? })` | An MCP server with all tools, the `implement_next_task` and `derive_model` prompts and `MCP_INSTRUCTIONS`; with a visualizer also the visualization tools, and it declares the `claude/channel` capability |
| `visualTools(host)`, `VisualHost`, `VISUAL_INSTRUCTIONS` | The visualization tools over a window host, the part of `Visualizer` they use, and the server instructions that explain them |
| `serveHttp(root, port)` | The MCP server over Streamable HTTP on `127.0.0.1`; returns `{ url, close() }` |
| `REGISTRY_PROMPT`, `CHAT_SYSTEM`, `MCP_INSTRUCTIONS` | The registry skill text, the chat system prompt and the MCP server instructions that make the model the source of truth for business logic |

Chat:

| Export | Purpose |
|---|---|
| `chat(root, messages, model)` | One chat turn on a working copy; yields `ChatEvent`s: `text`, `tool`, `proposal`, `error` |
| `modelSettings(root)`, `DEFAULT_MODEL`, `ModelSettings` | The `ai` section of `appling.config.json` with its defaults |
| `languageModel(settings)` | The AI SDK model for the settings |
| `Proposal`, `Hunk`, `ChatEvent` | The proposal and event types |
| `hunks(root, before, after)`, `graphDiff(before, after)` | The text and graph differences of a proposal |

The tools and the chat are described in [AI tools](../tools/ai.md).

## Visualization: @appling/viz

Open the visualization window from your own Node program:

```ts
import { Project } from '@appling/ai';
import { Visualizer } from '@appling/viz';

const project = new Project('models');
const window = new Visualizer({ root: 'models', graph: () => project.graph() });
window.onAsk(ask => console.error(ask.text, ask.selected));
await window.show({ view: 'machine', focus: ['sales.OrderFlow'], title: 'Order lifecycle' });
```

| Export | Purpose |
|---|---|
| `Visualizer` | The window host: `show(show)`, `selection()`, `reply(text, askId)`, `review(review)` (resolves with the decision), `onAsk(listener)`, `close()`. It serves the window on `127.0.0.1` with a random token, starts Electron on first use and pushes a new graph when `.appling` files change |
| `VisualizerOptions` | `root`, `graph()` and an optional `launch(url)` that starts the window, for tests |
| `Show`, `Review`, `Decision`, `Ask`, `Selection` | What the window draws, a proposal to decide, the decision, a question from the window, the current selection |
| `HostMessage`, `WindowMessage` | The websocket messages between host and window |

`@appling/viz/views` holds the pure view logic, without React or DOM imports:

| Export | Purpose |
|---|---|
| `GraphIndex` | The graph with children, parents and lineage by qualified name, and `relevanceOf(qn)`, the relevance of the declaration an element belongs to |
| `growTree(index, settings, unfolded, name?)` | The dependency tree of `settings.lens` as a `TreeNode`: the seed holds the modules, a module the declarations of the lens, a declaration the declarations that use it, grouped by kind when there is more than one; only the node ids in `unfolded` have children, the most relevant first |
| `revealPath(index, settings, qn)` | The node ids to unfold so that an element's declaration shows in its module |
| `factOf(index, node)` | The short fact a tree node shows under its name, such as `on Order · draft, placed → cancelled` |
| `LENSES`, `Lens` | The lenses (`domain`, `behavior`, `application`, `interfaces`, `access`) with their label and the kinds the tree starts from |
| `cardView(index, view, focus)` | The `machine`, `action`, `usecase` or `event` view of the focused elements as `Card`s: a title, a tag and sections of rows, each row selecting an element |
| `viewFor(kind)`, `VIEW_KINDS`, `ViewKind` | The view that draws an element kind |
| `search`, `relations`, `entityActions`, `actionSummary`, `memberText`, `kindLabel`, `elementAt` | The search, relations and summaries the IDE side panel shows |
| `ViewSettings`, `DEFAULT_VIEW` | The canvas options, the lens included |

`@appling/viz/canvas` exports the SVG tree `ModelCanvas` (one lens at a time, unfolded node by node, circles sized by relevance) and the card grid `CardCanvas`; import `@appling/viz/canvas.css` with them. They need `react` as a peer dependency.

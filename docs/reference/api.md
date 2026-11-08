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
| `@appling/ai` | Workspace access for AI, MCP server, agent sessions, playbook |
| `@appling/viz` | Model views, the canvases of Appling Desktop's repo view and the types of the visual tools |

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
| `ApplingScopeProvider` | The scope provider; `lookup(container, type, name)` resolves a dotted name as a reference would, `lookupElement(container, name)` an element of any kind |
| `doesNames(node)`, `doesTargets(node, services)` | The `@Name` occurrences of a node's [`does`](../language/descriptions.md) text with their document offsets, and with the element each names |
| `textBlockValue(raw)`, `printTextBlock(raw, indent, outer)` | The value of a `"""` text block, and its canonical spelling |
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
| `createApplingLspServices(context)` | The Appling services with Langium's LSP services; returns `{ shared, Appling }`. `realPath` in the context keeps one document per file across symlinked paths |
| `ApplingLspModule` | The Appling specific LSP services: formatter and hover |
| `ApplingDocumentUpdateHandler` | Replaces a copy read from disk with the path the editor opened, when both are the same file |
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
| `replaceReferencesIn(root, folder, updates)` | Replaces the references of these elements that point into `folder` (such as a generated project) with the given ranges, relative to the folder, and keeps their references elsewhere |
| `implementationStates(graph, { references, tasks, outstanding })` | The [implementation state](../tools/implementation.md#implementation-states) of every element (`ElementImplementation`: `state`, current `references`, open `tasks`, `outstanding`) |
| `fingerprint(node)`, `fingerprints(graph)`, `outstandingElements(graph, records)` | The hash generation records per element, and the elements new or changed since the given `GenerationRecord`s (every element for a missing record) |
| `anchorStates(graph, references, states)` | The state of every [sub-anchor](graph.md#sub-anchors) (`graph.anchors`): its own from its code references, else its element's (a handler's, its step's) |
| `subAnchors(qns)`, `isAnchorAddress(name)`, `anchorOwner(name)` | The sub-anchors of the elements of `qualifiedNames(models)` with their AST nodes; whether a name is an address; the element an address belongs to (`@appling/model/anchors`, browser safe) |
| `rollupState(states)`, `lineMarks(locations, texts, states)` | One state for several, and the mark of each model line that declares an element, by file URI (`LineMark`) |
| `ImplementationState`, `IMPLEMENTATION_STATES`, `TaskEntry`, `GenerationRecord` | The implementation types |
| `relevance(graph)` | The [relevance](../language/relevance.md) of every module and top level declaration, from 0 to 1, by qualified name |
| `relevanceLevel(score)`, `RELEVANCE_LEVELS`, `RelevanceLevel` | The level a score falls in, and the score range of each level |
| `diffGraphs(before, after)` | The model diff of two graphs as a `GraphDiff`: every `ElementChange` (`added`, `changed` or `removed`, by qualified name, with the properties and outgoing edges that differ), the lists of added, changed and removed names and `renamed`. Elements match by qualified name; the migration steps only the graph after has map old names to new ones, so a recorded rename is one change |
| `withRemoved(before, after, diff)` | The graph after with the removed elements of a diff put back under their parents, with their edges, so a canvas can draw them where they were |
| `migrationRenames(before, after)` | The function that maps a qualified name of the graph before to its name after through the new migration steps; undefined for a removed one |
| `GraphDiff`, `ElementChange`, `ChangeStatus` | The diff types |
| `findApplingFiles(path)` | The `.appling` files at a path, searching folders recursively and skipping hidden folders and `node_modules` |

`@appling/model/graph`, `@appling/model/edit`, `@appling/model/simulator`, `@appling/model/relevance`, `@appling/model/diff` and `@appling/model/implementation` export the graph, the edit operations, the simulator, the relevance functions, the model diff and the implementation states without the file system functions of the rest of the package, so a browser bundle can import them.

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
| `doesTask(node)` | The registry task of a node's [`does`](../language/descriptions.md) text, which `plan` adds to its entry |
| `describe(step)` | A one line description of a step, as `--plan` prints it |
| `coverage(entries)` | The registry entries per node kind: generated, partial, todo and the number of tasks, plus a total (`Coverage`) |
| `coverageTable(coverage)` | That coverage as the Markdown table `--plan` prints, the total with the generated share |
| `coverageReport(plans)` | The coverage of several extensions over several inputs (`PlannedInput[]`): per extension the total per input, the rows per kind, the total and its completion, plus an overall total (`CoverageReport`) |
| `completion(row)` | The completion of a row between 0 and 1: `(generated + partial / 2) / (generated + partial + todo)`, 1 without elements |
| `coverageMarkdown(report, base?, options?)` | The report as Markdown, as `generate --coverage` prints it; with a `base` report every figure shows its change and the changed kinds are listed. Options: `title`, `note`, `marker` (the first line `COVERAGE_MARKER`, default true) |
| `formatChange(now, before, options?)` | The change of one figure: `▲ +1.5 pp` for a gain, `▼ -2` for a drop, empty without change, `new` without a value before; `share` prints percentage points, `lowerIsBetter` makes a drop the gain (tasks) |
| `coverageBadge(report)` | A shields.io endpoint badge with the overall completion |
| `COVERAGE_MARKER` | The HTML comment that marks the sticky coverage comment of a pull request |
| `mapContext(graph, name, options)` | The `MapContext` passed to extensions |
| `checkPrerequisites(prerequisites)` | One message per missing tool |
| `runPlan(plan, out, log, written?)` | Runs the steps into `out` and writes the registry; with `written`, collects what each step wrote |
| `runSteps(steps, out, log, written?)` | Runs steps without writing a registry |
| `locateWritten(out, written, only?)` | Where the collected code is in the final files, by node (`WrittenRange[]`) |
| `addedRuns(before, after)`, `mainRun(runs)`, `Written`, `WrittenRange` | The runs of lines a template step added, and the one that holds its code |
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

Generation with code references and the implementation state, as the IDE does it:

| Export | Purpose |
|---|---|
| `generateElements({ root, graph, selection, targets?, load?, onEvent? })` | Generates the selection (`{ mode: 'outstanding' }`, `{ mode: 'all' }` or `{ mode: 'elements', elements }`) into every target: creates a target without a registry, merges the selected elements' files into an existing one, records references and fingerprints, and calls back with every `GenerationEvent` |
| `recordWritten(root, out, graph, written, elements)` | Records the references of collected code and the fingerprints of the elements for one target |
| `readGenerations(root)`, `recordGeneration(root, out, graph, elements)`, `GENERATIONS` | `<root>/.appling/generation.json`: the fingerprints of each target's last generation |
| `workspaceImplementation(root, graph)` | The implementation state of every element of a workspace, its targets (`TargetState`) and the open tasks of their registries (`TargetTask`) |
| `GenerationSelection`, `GenerationEvent`, `GenerationOptions`, `MergeScope` | The generation types; `mergeGeneration(out, next, exclude, scope?)` merges only a scope's files and registry entries |

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
| `createMcpServer(root, { visualizer?, onToolCall? })`, `McpServerOptions` | An MCP server with all tools, the `implement_next_task` and `derive_model` prompts and `MCP_INSTRUCTIONS`; with a visualizer also the visual tools; `onToolCall(tool, input, result)` sees every call, such as to attribute the files it wrote |
| `visualTools(host)`, `VisualHost`, `VISUAL_INSTRUCTIONS` | The visual tools over a host, what they need from it (the IDE server's canvas host of an agent session), and their server instructions |
| `createMcpServer(root, { session })`, `SessionScope`, `sessionTools(scope)`, `SESSION_INSTRUCTIONS` | With a session (`{ id, store, host? }`): the session tools, every call attributed to the session, conflict warnings on edits, and the instructions for coordinating with other sessions |
| `SessionStore`, `MemorySessionStore`, `AgentSession`, `SessionMessage`, `ClaimConflict`, `SESSION_STATUSES`, `SESSION_COLORS` | The [agent sessions](../tools/ai.md#agent-sessions): open (with its bearer token), authenticate, end, update label and status, claim, release, touch, send, post (a message from the user or the app), inbox, onChange |
| `serveSessionStore(store, channel)`, `RemoteSessionStore`, `ipcChannel(process)`, `Channel` | A store served to another process, such as an IDE server child of Appling Desktop, and reached from there |
| `IdeHost`, `IdeContext`, `IdeAction`, `AppHost`, `serveAppHost`, `remoteAppHost` | What `ide_context` and `ide_act` go through, and the part the app around the IDE server adds, also over IPC |
| `findConflicts(sessions, self, touched)`, `overlaps(a, b)`, `peers(sessions, self)`, `sessionTitle(session)` | The claim rules and a session's display name |
| `repoFolder(repo)`, `absolute(repo, file)` | A session's repo folder and a claimed file as the store keeps them: a local folder resolved, a remote one as it is on its machine (`ssh://` ids unchanged, POSIX folders by POSIX rules, also on Windows) |
| `PlaybookStore`, `MemoryPlaybookStore(folder?)`, `Playbook`, `Chapter`, `PlaybookStep`, `StepInput`, `PlaybookPosition`, `CHANGE_KINDS`, `RESPONSE_KINDS` | The [workspace playbooks](../tools/ai.md#the-playbook): open a chapter, add steps, mark them done, close, read, move the user, respond, onChange; with a folder, each playbook is kept there as a JSON file |
| `servePlaybookStore(store, channel)`, `RemotePlaybookStore` | A playbook store served to another process and reached from there, like the session store |
| `openChapter(store, author, chapter)`, `ChapterAuthor`, `ChapterWriter` | Writes a chapter without MCP, such as for a code generation run: `add`, `done`, `close`, `read` |
| `playbookTools(id, sessions, playbooks)`, `PLAYBOOK_INSTRUCTIONS`, `respondToStep(playbooks, sessions, chapter, step, response)` | The playbook tools of a session (`createMcpServer` adds them when `SessionScope.playbook` is set), their instructions, and the user's response, stored and delivered to the session's inbox |
| `playbookKey(session)`, `isUnwatched(chapter)`, `unwatched(playbook)`, `playbookPosition(playbook)` | A session's playbook, the unwatched chapters in total, per session and per repo, and where the user is |
| `handleMcpRequest(server, request, response, hosts?)` | Answers one Streamable HTTP request with a fresh server, as `serveHttp` and the IDE server do |
| `serveHttp(root, port)` | The MCP server over Streamable HTTP on `127.0.0.1`; returns `{ url, close() }` |
| `REGISTRY_PROMPT`, `MCP_INSTRUCTIONS` | The registry skill text and the MCP server instructions that make the model the source of truth for business logic |

Proposals:

| Export | Purpose |
|---|---|
| `proposal(project, context)` | The operations a `ProposalContext` collected, with their text and graph differences, as `propose_edits` shows them |
| `Proposal`, `Hunk` | The proposal types |
| `hunks(root, before, after)`, `graphDiff(before, after)` | The text and graph differences of a proposal |

The tools are described in [AI tools](../tools/ai.md).

## Visualization: @appling/viz

The root export (also `@appling/viz/protocol`) has the types the [visual tools](../tools/ai.md#visual-tools) exchange with the canvas:

| Export | Purpose |
|---|---|
| `Show`, `Bubble`, `Review`, `Decision`, `Selection`, `Status` | A view of focused elements with a title and note, a note or code example on an element, a proposal to decide, the decision, the person's selection and view, the step the agent works on with its progress |
| `nextShow(current, next)` | The view after the next one: a `node` view on a `node` view adds its elements, and whether the bubbles stay |

`@appling/viz/views` holds the pure view logic, without React or DOM imports:

| Export | Purpose |
|---|---|
| `GraphIndex` | The graph with children, parents and lineage by qualified name, and `relevanceOf(qn)`, the relevance of the declaration an element belongs to |
| `growTree(index, settings, unfolded, name?, trail?)` | The dependency tree of `settings.lens` as a `TreeNode`: the seed holds the modules, a module the declarations of the lens, a declaration the declarations that use it, grouped by kind when there is more than one; only the node ids in `unfolded` have children, the most relevant first; a node id in `trail` shows only its children in `unfolded` or `trail` |
| `trailOf(index, settings, focus)`, `lensOf(kind)` | The `unfolded` and `trail` sets that draw the focused elements one after another, each unfolded in place, with the node id of each; the lens that starts from a kind |
| `changeMarks(index, changes, modules?)`, `MarkedChanges`, `ChangeMark` | The declarations that added, changed and removed elements belong to, each `added` or `removed` when the declaration itself is new or gone, else `changed`; removed elements count only when the index has them (see `withRemoved`); with `modules`, the modules that hold a marked declaration are `changed` too |
| `sessionMarks(index, marks)`, `SessionMark` | The declarations that the elements claimed or highlighted by agent sessions belong to, each with the first session's mark |
| `revealPath(index, settings, qn)` | The node ids to unfold so that an element's declaration shows in its module |
| `factOf(index, node)` | The short fact a tree node shows under its name, such as `on Order · draft, placed → cancelled` |
| `LENSES`, `Lens` | The lenses (`domain`, `behavior`, `application`, `interfaces`, `access`) with their label and the kinds the tree starts from |
| `cardView(index, view, focus)` | The `action` or `event` view of the focused elements as `Card`s: a title, a tag and sections of rows, each row selecting an element |
| `flowView(index, view, focus)` | The `machine` or `usecase` view as a `Flow`: nodes for the states or steps, edges for the transitions or the step order |
| `viewFor(kind)`, `VIEW_KINDS`, `ViewKind`, `anchorOf(index, qn, drawn)` | The view that draws an element kind; the innermost of an element and its ancestors that a view draws |
| `search`, `relations`, `entityActions`, `actionSummary`, `memberText`, `kindLabel`, `elementAt` | The search, relations and summaries the IDE side panel shows |
| `ViewSettings`, `DEFAULT_VIEW` | The canvas options, the lens included |

`@appling/viz/canvas` exports the SVG tree `ModelCanvas` (one lens at a time, unfolded node by node, circles sized by relevance, only trails when given a `focus`), the SVG flowchart `FlowCanvas` and the card grid `CardCanvas`, each with optional `bubbles`; `ModelCanvas` also marks the declarations and modules of optional `changes` (any `MarkedChanges`, such as a `GraphDiff`), draws removed ones ghosted (dashed while `changes.planned`, and played once more each time the optional `beat` changes) and rings those of optional `sessions` (`SessionMark[]`) in the session's colour; import `@appling/viz/canvas.css` with them. They need `react` as a peer dependency.

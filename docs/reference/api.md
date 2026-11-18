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
| `@appling/ai` | Workspace access for AI, MCP server, agent sessions |
| `@appling/viz` | Model views, the canvases of the inspector and the types of the visual tools |

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
| `effectEntity(node)` | The entity of the action or machine an effect belongs to |
| `ApplingScopeProvider` | The scope provider; `lookup(container, type, name)` resolves a dotted name as a reference would, `lookupElement(container, name)` an element of any kind |
| `doesNames(node)`, `doesTargets(node, services)` | The `@Name` occurrences of a node's [`describe` and annotation](../language/descriptions.md) texts with the text they stand in (`property`) and their document offsets, and with the element each names |
| `textBlockValue(raw)`, `printTextBlock(raw, indent, outer)` | The value of a `"""` text block, and its canonical spelling |
| `ExpressionTyper` | Types expressions: `checkModel(model)` fills `types`, `targets` (the element each name stands for) and `problems` (`Problem[]`); `typeOf(expr)` types one expression in its position, `namesAt(effect)` lists the names an effect sees |
| `show(type)`, `typeOfRef(ref)` | The display name of a `Type`, such as `Money?`, and the `Type` a `TypeRef` declares |
| `LAYER_OF`, `Layer` | The layer of every top level declaration type |
| `mayReference(from, to)` | Whether a declaration of kind `from` may reference one of kind `to` under the layer rules; also at the langium free subpath `@appling/lang/layers` |
| `ANNOTATIONS`, `Annotation`, `annotationOf(node)` | The [annotation](../language/descriptions.md) keyword of each layer, and a graph node's annotation (`{ keyword, text }`) from its `layer` and `props`; also at `@appling/lang/layers` |
| `scenarioTarget(scenario)`, `scenarioErrors(scenario)`, `scenarioActor(scenario, actors)` | What a scenario's `when` runs, the errors it may fail with and the actor it runs as |
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
| `throughPath(value, entity, path)` | The value of a `set` inside `update <path> { ... }` with every name of a field of the updated entity read through the path, such as `item.product.stock` for `stock` |
| `applyEdit(sources, operation, { release })` | Applies one edit operation, see [Edit operations](edit-operations.md) |
| `EditOperation`, `EditResult`, `TextEdit` | The edit types |
| `writeRelease(root, version, graph)` | Writes `<root>/.appling/releases/<version>.json` and returns its path; throws for an invalid or existing version |
| `readReleases(root)`, `latestRelease(releases)` | All releases of a workspace, and the one with the highest version |
| `releasesDir(root)` | `<root>/.appling/releases` |
| `migrationBlockName(version)` | The migration block for steps after a release: `1.0.0` gives `since_v1_0_0` |
| `Release` | `{ version, created, graph }` |
| `resolveReferences(root, graph?, folders?)` | Every [code reference](../tools/references.md): each `@appling` marker in the code of the folders (default `markerFolders(root)`) with the declaration it marks; with a graph, its status `current`, `stale` or `orphaned`, a name renamed by a migration step mapped to its name now (async) |
| `recordReferences(root, graph, qn, places, folders?)` | Writes the marker of an element or sub-anchor with its fingerprint above the declaration on each `{ file, line }`, renews one it has there, removes its markers elsewhere and returns its references (async); throws for an unknown element, a missing file, a file outside the folders, an empty line or one that starts no declaration |
| `markerFolders(root, extra?)`, `markerFingerprint(graph, qn)` | The folders searched for markers: the git work tree around the workspace (or the workspace) and the extra ones; the fingerprint a marker of an element (a sub-anchor: its element's) carries |
| `findMarkers(text, extension)`, `markersOf(path)`, `scanMarkers(folders)` | The markers of a text with their ranges by tree-sitter (or indentation), of a file (cached by size and time), of every code file in some folders (async) |
| `writeMarker(path, line, qn, fingerprint?)`, `removeMarkerLines(path, lines)`, `markerLine(path, qn, fingerprint, indent)`, `largestDeclaration(text, extension, start, end)`, `MARKER_LANGUAGES` | Writing and removing markers, the comment syntax of each code file extension, and the declaration generation marks among the lines it wrote |
| `CodeReference`, `ResolvedReference`, `ReferenceStatus`, `Marker` | The reference types |
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
| `Simulator`, `UNKNOWN` | The [simulator](../tools/simulator.md): `reach`, `actors`, `access`, `risks`, `run`, `evaluate`, and `scenario(qn)`, which runs one [scenario](../language/scenarios.md) and returns a `ScenarioResult` (`passed`, `failures`, `outcome`, `errors`, `reasons`, `events`, `rows`) |
| `runScenarios(graph)`, `checkScenarios(models, services)` | Every scenario's result, and the failures as `ScenarioProblem`s (`scenario`, `uri`, `range` of its name, `message`), as `appling check` reports them |
| `scenarioCall(node)`, `coveredByScenarios(graph)` | What a scenario's `when` runs (`target`, `args`), and the actions, use cases and transitions the scenarios cover |
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
| `STACKS`, `STACK_LABELS`, `Stack` | The stacks by extension package (`django: '@appling/codegen-django'`, `ash`, `go`, `rust`) and their names; also from the browser safe `@appling/codegen/stacks` |
| `addTarget(root, stack, name)` | Adds the stack's target (`build/<name>`) to `appling.config.json` unless it has one, and its `STACK_LOCAL` files to `.gitignore` |
| `STACK_LOCAL`, `ignore(root, lines)` | Each stack's local files in a generated project; appends the lines `.gitignore` lacks |
| `CodegenExtension` | The extension contract: `name`, `prerequisites`, `test`, `setup`, `steps`, `migrate` |
| `Step`, `CommandStep`, `TemplateStep`, `TaskStep` | The three step kinds |
| `MapContext`, `Prerequisite` | What an extension gets per node, and a tool it needs |
| `templateRenderer(root, extension, options)`, `Render`, `overrideFolder(root, extension, options)`, `ORIGINAL` | The Nunjucks renderer behind `context.render`: the project's [override folder](../codegen/templates.md) first, then the extension's `templates`; `original:` names the extension's own template |

Planning and running:

| Export | Purpose |
|---|---|
| `plan(graph, extension, name, options, root?)` | The ordered steps and one registry entry per node (`Plan`); `root` (default `.`) is the project folder that holds the template overrides |
| `annotationTask(node)` | The registry task of a node's [annotation](../language/descriptions.md), which `plan` adds to its entry: `implement what <Name> <keyword>: <text>` |
| `aboutOf(node)` | The documentation of a node in generated code: its `describe` text, then its annotation |
| `describe(step)` | A one line description of a step, as `--plan` prints it |
| `coverage(entries)` | The registry entries per node kind: generated, partial, todo, the number of tasks (generator gaps) and of tasks left to code, plus a total (`Coverage`); an entry whose only tasks are left to code counts as generated |
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

Generation with code references and the implementation state, as `appling generate` does it:

| Export | Purpose |
|---|---|
| `generateElements({ root, graph, selection, targets?, load?, onEvent? })` | Generates the selection (`{ mode: 'outstanding' }`, `{ mode: 'all' }` or `{ mode: 'elements', elements }`) into every target: creates a target without a registry, merges the selected elements' files into an existing one, marks the code and records fingerprints, and calls back with every `GenerationEvent` |
| `runPlan(plan, out, log)` | Runs the steps into `out`, marks the code each element got with its `@appling` marker, writes the registry and the baseline (async) |
| `workspaceReferences(root, graph?)` | The code references of a workspace: the markers in its git work tree and every configured target |
| `readGenerations(root)`, `recordGeneration(root, out, graph, elements)`, `GENERATIONS` | `<root>/.appling/generation.json`: the fingerprints of each target's last generation |
| `workspaceImplementation(root, graph, references?)` | The implementation state (async) of every element of a workspace, its targets (`TargetState`) and the tasks of their registries, open and done (`TargetTask`) |
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
| `MODEL_TOOLS`, `AUTHORING_TOOLS`, `REGISTRY_TOOLS`, `REFERENCE_TOOLS`, `VIEW_TOOLS`, `Tools` | The tool definitions: description, zod input shape and `run(context, input)` |
| `operationSchema` | The zod schema of an edit operation |
| `ToolContext`, `diskContext(project)` | Where tools read and write: the files on disk |
| `createMcpServer(root, { visualizer?, onToolCall? })`, `McpServerOptions` | An MCP server with all tools, the `implement_next_task` and `derive_model` prompts and `MCP_INSTRUCTIONS`; with a visualizer also the visual tools; `onToolCall(tool, input, result)` sees every call, such as to attribute the files it wrote |
| `visualTools(host)`, `VisualHost`, `VISUAL_INSTRUCTIONS` | The visual tools over a host, what they need from it (the inspector server's canvas host of an agent session), and their server instructions |
| `createMcpServer(root, { session })`, `SessionScope`, `sessionTools(scope)`, `SESSION_INSTRUCTIONS` | With a session (`{ id, store, host? }`): the session tools, every call attributed to the session, conflict warnings on edits, and the instructions for coordinating with other sessions |
| `SessionStore`, `MemorySessionStore`, `AgentSession`, `SessionMessage`, `ClaimConflict`, `SESSION_STATUSES`, `SESSION_COLORS` | The [agent sessions](../tools/ai.md#agent-sessions): open (with its bearer token), authenticate, end, update label and status, claim, release, touch, send, post (a message from the user or the app), inbox, onChange |
| `serveSessionStore(store, channel)`, `RemoteSessionStore`, `ipcChannel(process)`, `Channel` | A store served to another process, such as an inspector server child of the VS Code extension, and reached from there |
| `IdeHost`, `IdeContext`, `IdeAction`, `AppHost`, `serveAppHost`, `remoteAppHost` | What `ide_context` and `ide_act` go through, and the part the app around the inspector server adds, also over IPC |
| `findConflicts(sessions, self, touched)`, `overlaps(a, b)`, `peers(sessions, self)`, `sessionTitle(session)` | The claim rules and a session's display name |
| `handleMcpRequest(server, request, response, hosts?)` | Answers one Streamable HTTP request with a fresh server, as `serveHttp` and the inspector server do |
| `serveHttp(root, port)` | The MCP server over Streamable HTTP on `127.0.0.1`; returns `{ url, close() }` |
| `REGISTRY_PROMPT`, `MCP_INSTRUCTIONS` | The registry skill text and the MCP server instructions that make the model the source of truth for business logic |

Agent sessions in an app's terminals, `@appling/ai/agents` (what the VS Code extension starts):

| Export | Purpose |
|---|---|
| `BUILTIN_PRESETS`, `agentPresets(settings)`, `PRESETS_KEY`, `AgentPreset`, `Wiring`, `WIRINGS`, `AnswerKeys` | The agents a session can run: the built in ones plus the custom ones of `agents.presets`, with the problems found in them |
| `attach(preset, context)` | The agent's own commands that add the session's MCP server to the local configuration of an agent the app did not start, and remove it again; undefined for an agent without such a command (only Claude Code has one) |
| `launch(preset, context)`, `LaunchContext`, `Launch`, `SERVER`, `CLAUDE_HOOKS`, `GEMINI_HOOKS`, `OPENCODE_EVENTS`, `OPENCODE_PLUGIN`, `geminiSystemSettingsFile()` | The command, arguments, environment and files that start a preset's agent wired to its session's MCP server and hooks |
| `Gateway`, `GatewayOptions` | The one local endpoint the agents reach: `/mcp` forwarded to the session's inspector server, `/hooks/<event>`, both with the session's bearer token |
| `reduce(state, signal)`, `hookSignal(wiring, event, body)`, `notificationSignal(wiring, notification)`, `answers(state, data)`, `waiting(status)`, `AgentStatus`, `StatusState`, `Signal`, `AgentPrompt`, `TerminalNotification`, `STATUS_COLORS`, `STATUS_LABELS` | A session's status from its hooks, its terminal notifications and its exit |
| `answerKeys(keys, answer)`, `isAnswer(value)`, `Answer` | The keys that answer a waiting agent in its terminal |

The tools are described in [AI tools](../tools/ai.md).

## Visualization: @appling/viz

The root export (also `@appling/viz/protocol`) has the types the [visual tools](../tools/ai.md#visual-tools) exchange with the canvas:

| Export | Purpose |
|---|---|
| `Show`, `Bubble`, `Selection`, `Status` | A view of focused elements with a title and note, a note or code example on an element, the person's selection and view, the step the agent works on with its progress |
| `nextShow(current, next)` | The view after the next one: a `node` view on a `node` view adds its elements, and whether the bubbles stay |

`@appling/viz/views` holds the pure view logic, without React or DOM imports:

| Export | Purpose |
|---|---|
| `GraphIndex` | The graph with children, parents and lineage by qualified name, and `relevanceOf(qn)`, the relevance of the declaration an element belongs to |
| `growTree(index, settings, unfolded, name?, trail?)` | The pyramid from the entry level `settings.lens` as a `TreeNode`: the seed holds the modules, a module its declarations of the entry level, a declaration the declarations of higher levels that rest on it (`side: 'up'`) and those of lower levels it rests on (`side: 'down'`), each with its `level`; the seed and a module unfold with their id in `unfolded`, a side of a declaration with its `sideId`; away from the entry level a branch keeps its side; a declaration is drawn once, and a node whose unfolded side also leads to one drawn before lists it in `links` (`open` lists the unfolded sides); a node id in `trail` shows only its children in `unfolded` or `trail` |
| `sideId(id, side)`, `Side` | The id in `unfolded` that opens one side of a declaration: `<id>^up` or `<id>^down` |
| `linked(index, qn, side)`, `peers(index, qn)`, `levelOf(kind)` | The declarations one step up or down from a declaration, a role, actor or tenant leading through the pages and interfaces that expose what its policies name; the declarations of its own level it belongs together with; the level of a kind, 1 to 5, none for scenarios and migrations |
| `trailOf(index, settings, focus)`, `lensOf(kind)` | The `unfolded` and `trail` sets that draw the focused elements one after another, each unfolded in place, with the node id of each; the level whose band holds a kind |
| `changeMarks(index, changes, modules?)`, `MarkedChanges`, `ChangeMark` | The declarations that added, changed and removed elements belong to, each `added` or `removed` when the declaration itself is new or gone, else `changed`; removed elements count only when the index has them (see `withRemoved`); with `modules`, the modules that hold a marked declaration are `changed` too |
| `sessionMarks(index, marks)`, `SessionMark` | The declarations that the elements claimed or highlighted by agent sessions belong to, each with the first session's mark |
| `revealPath(index, settings, qn)` | The node ids to unfold so that an element's declaration shows in its module |
| `factOf(index, node)` | The short fact a tree node shows under its name, such as `on Order · draft, placed → cancelled` |
| `LENSES`, `Lens` | The levels L1 to L5 (`domain`, `behavior`, `application`, `interfaces`, `access`) with their label, their question and their kinds |
| `cardView(index, view, focus)` | The `action` or `event` view of the focused elements as `Card`s: a title, a tag and sections of rows, each row selecting an element |
| `flowView(index, view, focus)` | The `machine` or `usecase` view as a `Flow`: nodes for the states or steps, edges for the transitions or the step order |
| `viewFor(kind)`, `VIEW_KINDS`, `ViewKind`, `anchorOf(index, qn, drawn)` | The view that draws an element kind; the innermost of an element and its ancestors that a view draws |
| `relations`, `entityActions`, `actionSummary`, `memberText`, `kindLabel`, `elementAt` | The relations and summaries the inspector shows |
| `ViewSettings`, `DEFAULT_VIEW` | The canvas options, the entry level (`lens`) included |

`@appling/viz/canvas` exports the SVG pyramid `ModelCanvas` (five level bands from one entry level, unfolded side by side of each declaration, only trails when given a `focus`), the SVG flowchart `FlowCanvas` and the card grid `CardCanvas`, each with optional `bubbles`; `ModelCanvas` also marks the declarations and modules of optional `changes` (any `MarkedChanges`, such as a `GraphDiff`), draws removed ones ghosted and rings those of optional `sessions` (`SessionMark[]`) in the session's colour; import `@appling/viz/canvas.css` with them; it takes its colours from the `--appling-*` theme tokens. They need `react` as a peer dependency.

---
title: API
description: The public TypeScript API of the Appling packages, export by export, with one usage example per package.
---

Every tool in Appling is built on these public packages. Use them to build your own checks, reports, editors, generators or agents. All packages are ES modules for Node 24.

| Package | Purpose |
|---|---|
| `@appling/lang` | Grammar, parser, scoping, validation, expression typing, canonical printer |
| `@appling/lang/lsp` | The language server services |
| `@appling/model` | Semantic graph, edit operations, releases |
| `@appling/codegen` | Code generation core: plans, registry, migrations |
| `@appling/ai` | Workspace access for AI, MCP server, agent sessions |
| `@appling/viz` | Model views, the canvases of the inspector and the types of the visual tools |
| `@appling/inspect` | The inspector server as a child process of an app, and the messages between the client and a host |
| `@appling/codegen-django`, `@appling/codegen-ash`, `@appling/codegen-go`, `@appling/codegen-rust` | Code generation extensions; each exports its `CodegenExtension` as default, see [Writing extensions](../codegen/extensions.md) |

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
| `ApplingWorkspaceSymbolProvider` | Every named element by qualified name, a shared service (`shared.lsp.WorkspaceSymbolProvider`) |

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
| `Simulator`, `UNKNOWN` | The [simulator](../tools/simulator.md): `reach`, `actors`, `access`, `risks`, `run`, `matches(query, record, actor, inputs?)` (whether a record belongs to a query's results: `true`, `false` or `UNKNOWN`), `evaluate`, and `scenario(qn)`, which runs one [scenario](../language/scenarios.md) and returns a `ScenarioResult` (`passed`, `failures`, `outcome`, `errors`, `reasons`, `events`, `rows`) |
| `runScenarios(graph)`, `checkScenarios(models, services)` | Every scenario's result, and the failures as `ScenarioProblem`s (`scenario`, `uri`, `range` of its name, `message`), as `appling check` reports them |
| `scenarioCall(node)`, `coveredByScenarios(graph)` | What a scenario's `when` runs (`target`, `args`), and the actions, use cases and transitions the scenarios cover |
| `findApplingFiles(path)` | The `.appling` files at a path, searching folders recursively and skipping hidden folders and `node_modules` |

`@appling/model/graph`, `@appling/model/edit`, `@appling/model/simulator`, `@appling/model/relevance`, `@appling/model/diff`, `@appling/model/anchors` and `@appling/model/implementation` export the graph, the edit operations, the simulator, the relevance functions, the model diff, the sub-anchors and the implementation states without the file system functions of the rest of the package, so a browser bundle can import them.

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
| `CodegenExtension` | The extension contract: `name`, `templates` (the folder of its Nunjucks templates), `prerequisites`, `test`, `syncExclude` (paths `--sync` never reads or writes, `**` and `*` globs), `setup`, `steps`, `migrate` |
| `Step`, `CommandStep`, `TemplateStep`, `TaskStep` | The three step kinds |
| `MapContext`, `Prerequisite` | What an extension gets per node, and a tool it needs: `name`, `command`, `expect`, `hint` and `needed(graph)`, whether a model needs it (default: every model does) |
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
| `extensionLabel(name)` | The short name of an extension package: `@appling/codegen-django` gives `django` |
| `mapContext(graph, name, options, render)` | The `MapContext` passed to extensions, with `render` from `templateRenderer` |
| `checkPrerequisites(prerequisites, graph?)` | One message per missing tool; with a graph, only for the tools that model needs |
| `runPlan(plan, out, log)` | Runs the steps into `out`, marks the code each element got with its `@appling` marker, writes the registry and the baseline (async); stops at the first failing command |
| `runSteps(steps, out, log, written?)` | Runs steps without writing a registry; with `written`, collects what each step wrote |
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
| `planMigrations(graph, extension, name, options, out, changes, root?)` | Asks the extension's `migrate` for the steps of every change; `root` (default `.`) holds the template overrides |
| `runMigrations(out, plan, changes, log)` | Runs them, adds the tasks to the registry and records the changes as applied |
| `readApplied(out)` | The ids in `<out>/.appling/migrations.json` |
| `MigrationChange`, `ProjectFiles`, `APPLIED` | The change type, read access to the project for extensions, and the applied file path |

Generation with code references and the implementation state, as `appling generate` does it:

| Export | Purpose |
|---|---|
| `generateElements({ root, graph, selection, targets?, load?, onEvent? })` | Generates the selection (`{ mode: 'outstanding' }`, `{ mode: 'all' }` or `{ mode: 'elements', elements }`) into every target: creates a target without a registry, merges the selected elements' files into an existing one, marks the code and records fingerprints, and calls back with every `GenerationEvent` |
| `workspaceReferences(root, graph?)` | The code references of a workspace: the markers in its git work tree and every configured target |
| `readGenerations(root)`, `recordGeneration(root, out, graph, elements)`, `GENERATIONS` | `<root>/.appling/generation.json`: the fingerprints of each target's last generation |
| `workspaceImplementation(root, graph, references?)` | The implementation state (async) of a workspace as `WorkspaceImplementation`: `states` of every element, `anchors` (the states of the sub-anchors), its `targets` (`TargetState`) and the tasks of their registries, open and done (`TargetTask`) |
| `GenerationSelection`, `GenerationEvent`, `GenerationOptions` | The generation types |

Sync, as `appling generate --sync` does it:

| Export | Purpose |
|---|---|
| `BASELINE`, `saveBaseline(out, exclude)` | `.appling/baseline`, and storing what generation produced there (its files, without the excluded paths, and its registry) as the base of the next sync |
| `mergeGeneration(out, next, exclude, scope?)` | Merges a fresh generation in `next` into the project three ways (baseline, project, new generation) and makes it the new baseline; with a `MergeScope` (`files`, `entries`) only those files and registry entries. Returns a `SyncReport`: `updated`, `added`, `removed`, `merged`, `conflicts` (files left with conflict markers) and `kept` (files the model no longer produces that you changed) |
| `projectFiles(root, exclude)` | The files of a project relative to its root, without `.appling`, `.git`, `node_modules` and the excluded paths |

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
| `Project` | A workspace folder: `sources()`, `check()`, `graph()`, `source(qn)`, `edit(operation)` with the latest release, `write(sources)`, `writeModelFile(path, source)` (creates or replaces one `.appling` file when the workspace still validates with it), `setIcons(icons)` (the canvas icons in `.appling/view.json`), the registry methods `targets()`, `nextTask(target?, skip?)`, `updateTask(qn, status, note?, target?)`, `runTests(target?)`, `references(qn?)` and `recordReferences(qn, places)` for the code references, and `implementation(module?)`, the counts per implementation state and the elements that are not implemented or outstanding |
| `queryGraph(graph, query)` | What the `graph_query` tool returns |
| `languageReference(page?)` | What the `language_reference` tool returns: every page of the language documentation with its title and description, or one page as Markdown |
| `MAX_ATTEMPTS` | Attempts after which a registry entry stops coming back, `3` |
| `Sources` | `{ [uri]: text }` |

Tools and MCP:

| Export | Purpose |
|---|---|
| `MODEL_TOOLS`, `AUTHORING_TOOLS`, `REGISTRY_TOOLS`, `REFERENCE_TOOLS`, `VIEW_TOOLS`, `Tools` | The tool definitions: description, zod input shape and `run(context, input)` |
| `define(definition)` | Types one tool definition by its input shape |
| `operationSchema` | The zod schema of an edit operation |
| `ToolContext`, `diskContext(project)` | Where tools read and write: the files on disk |
| `createMcpServer(root, { visualizer?, onToolCall? })`, `McpServerOptions` | An MCP server with all tools, the `implement_next_task` and `derive_model` prompts and `MCP_INSTRUCTIONS`; with a visualizer also the visual tools; `onToolCall(tool, input, result)` sees every call, such as to attribute the files it wrote |
| `visualTools(host)`, `VisualHost`, `VISUAL_INSTRUCTIONS` | The visual tools over a host, what they need from it (the inspector server's canvas host of an agent session), and their server instructions |
| `createMcpServer(root, { session })`, `SessionScope`, `sessionTools(scope)`, `SESSION_INSTRUCTIONS` | With a session (`{ id, store, host? }`): the session tools, every call attributed to the session, conflict warnings on edits, and the instructions for coordinating with other sessions |
| `SessionStore`, `MemorySessionStore`, `AgentSession`, `SessionMessage`, `ClaimConflict`, `SESSION_STATUSES`, `SESSION_COLORS` | The [agent sessions](../tools/ai.md#agent-sessions): open (with its bearer token), authenticate, end, update label and status, claim, release, touch, send, post (a message from the user or the app), inbox, onChange |
| `serveSessionStore(store, channel)`, `RemoteSessionStore`, `ipcChannel(process)`, `Channel` | A store served to another process, such as an inspector server child of the VS Code extension, and reached from there |
| `IdeHost`, `IdeContext`, `IdeAction`, `IDE_ACTIONS`, `AppHost`, `serveAppHost`, `remoteAppHost` | What `ide_context` and `ide_act` go through (the actions `focus`, `open`, `highlight` and `reveal`), and the part the app around the inspector server adds, also over IPC |
| `findConflicts(sessions, self, touched)`, `overlaps(a, b)`, `peers(sessions, self)`, `sessionTitle(session)` | The claim rules and a session's display name |
| `touchedBy(tool, input, result)`, `conflictWarning(conflicts)` | The elements and files a tool call touches, for the claim check, and the warning an edit that touches other sessions' claims comes back with |
| `handleMcpRequest(server, request, response, hosts?)` | Answers one Streamable HTTP request with a fresh server, as `serveHttp` and the inspector server do |
| `serveHttp(root, port)` | The MCP server over Streamable HTTP on `127.0.0.1`; returns `{ url, close() }` |
| `REGISTRY_PROMPT`, `REVERSE_PROMPT`, `MCP_INSTRUCTIONS` | The registry skill text (the `implement_next_task` prompt), the reverse engineering skill text (the `derive_model` prompt) and the MCP server instructions that make the model the source of truth for business logic |

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
| `trailOf(index, settings, focus, folded?)`, `lensOf(kind)` | The `unfolded` and `trail` sets that draw the focused elements one after another, each unfolded in place (with `folded`, each stays folded in its module), with the node id of each; the level whose band holds a kind |
| `modelPulse(before, after, qns)` | Which of these elements a new model added (`added`) or changed in itself or in something it holds (`changed`) |
| `changeMarks(index, changes, modules?)`, `MarkedChanges`, `ChangeMark` | The declarations that added, changed and removed elements belong to, each `added` or `removed` when the declaration itself is new or gone, else `changed`; removed elements count only when the index has them (see `withRemoved`); with `modules`, the modules that hold a marked declaration are `changed` too |
| `sessionMarks(index, marks)`, `SessionMark` | The declarations that the elements claimed or highlighted by agent sessions belong to, each with the first session's mark |
| `implementationMarks(index, states)`, `IMPLEMENTATION_LABELS` | The implementation state the canvas draws per declaration (its own and its members' rolled up) and per module (that of its declarations); the words for each state |
| `revealPath(index, settings, qn)` | The node ids to unfold so that an element's declaration shows in its module |
| `factOf(index, node)` | The short fact a tree node shows under its name, such as `on Order · draft, placed → cancelled` |
| `LENSES`, `Lens` | The levels L1 to L5 (`domain`, `behavior`, `application`, `interfaces`, `access`) with their label, their question and their kinds |
| `cardView(index, view, focus)` | The `action` or `event` view of the focused elements as `Card`s: a title, a tag and sections of rows, each row selecting an element |
| `flowView(index, view, focus)` | The `machine` or `usecase` view as a `Flow`: nodes for the states or steps, edges for the transitions or the step order |
| `useCaseDiagram(index, level?)`, `UseCaseDiagram`, `layoutUseCases(diagram)` | The use case diagram of the whole model: actors, use cases and the actions their steps call as subfunctions, an association where one of a use case's policies names the actor or one of its roles, include where a step calls a use case or an action; its placement as chips (`UseCaseChip`), the actors left of one system boundary beside the use cases they start, joined by curves |
| `ModelView`, `ViewSettings.view` | The views of the inspector's rail, `levels`, `usecases`, `states` and `screens`; the chosen one, kept in `.appling/view.json` |
| `screenFlow(index, actor, level?)`, `ScreenFlow`, `Screen`, `ScreenPart`, `ScreenMenu` | The mockup of one actor: the pages it may read or act on, each component with its fields and only the actions the actor may run, the page a list row opens, the navigations as menus cut to those pages, and the steps of the flows of the use cases it starts |
| `layoutStates(flow)` | A machine's `Flow` placed as a UML state diagram, top down from the initial state to the states nothing leaves: one curve per pair of states, a trigger from many states or into many states as a bundle beside its target (`bundle`), transitions that lead back marked `back`, and the initial pseudostate (`PlacedFlow.initial`) |
| `byRelevance(index, kind)` | The declarations of a kind, the most relevant first |
| `viewFor(kind)`, `VIEW_KINDS`, `ViewKind`, `anchorOf(index, qn, drawn)` | The view that draws an element kind; the innermost of an element and its ancestors that a view draws |
| `relations`, `entityActions`, `actionSummary`, `memberText`, `kindLabel`, `elementAt` | The relations and summaries the inspector shows |
| `abilities(index, access)`, `policyText(index, qn)` | What an actor may do (from `Simulator.access`), grouped as actions, pages with the actions they offer, use cases, queries and entity data; a policy as one line, such as `Order policy[read]: actor.is(crm.Clerk)` |
| `plural(kind)`, `LAYERS`, `LAYER_LABELS` | A kind in the plural (`Entities`, `Use cases`); the six layers and their names |
| `ViewSettings`, `DEFAULT_VIEW`, `relevantFor(index, qn, level?)` | The canvas options, the entry level (`lens`) and the least relevance level the views draw (`relevance`, `core` by default, everything when unset) included; whether a declaration reaches that level |

`@appling/viz/icons` exports `iconOf(name)`, the shapes (`Icon`) of a [Lucide](https://lucide.dev/icons) icon by its name, such as `shopping-cart`, undefined when there is none; `ViewSettings.icons` maps nodes to icon names.

`@appling/viz/canvas` exports the SVG pyramid `ModelCanvas` (five level bands from one entry level, unfolded side by side of each declaration, only trails when given a `focus`), the SVG flowchart `FlowCanvas` (a UML state diagram with `states`) and the card grid `CardCanvas`, each with optional `bubbles`, the SVG use case diagram `UseCaseCanvas` and the clickable wireframe `ScreenCanvas`, the dropdown `Select` (`value`, `options` of `SelectOption`, `label`, `onChange`; `qualifiedOptions(qns)` gives a name per option with its module as the hint), and `Glyph` (`name`, `size`), a Lucide icon in the colour of the text around it; `ModelCanvas` also marks the declarations and modules of optional `changes` (any `MarkedChanges`, such as a `GraphDiff`), draws removed ones ghosted and rings those of optional `sessions` (`SessionMark[]`) in the session's colour; import `@appling/viz/canvas.css` with them; it takes its colours from the `--appling-*` theme tokens. They need `react` as a peer dependency.

`StoryCanvas` (`story`, `index`, `name`) draws one story: a view (`levels`, `states`, `usecases` or `screens`) started from one element, the level canvas from that element's own level, a diagram scaled to fit its box. `@appling/viz/stories` exports `STORIES`, the stories the landing site and the demo's stories page draw on the sample model (`Story`: `id`, `view`, `element`, `title`, `question`, `text`).

## Inspector: @appling/inspect

The package has no root export. An app such as the VS Code extension uses three subpaths:

| Export | Purpose |
|---|---|
| `startInspectProcess(root, options?)` (`@appling/inspect/process`) | Starts the inspector server of a folder as a child process with an IPC channel on a free port and resolves with `{ url, mcp, child, close() }` once it reports its address. Options: `node`, `env`, `main` (the server's entry), `timeout`, `onExit(code, stderr)`, `onStatus(status)` (the model errors), `onImplementation(marks)` (the implementation marks and the code links), `sessions` (a shared `SessionStore`) and `host` (an `AppHost`) |
| `PANELS`, `PanelState`, `PanelAction` (`@appling/inspect/panels`) | The side panels a host draws itself (`inspector`, `playbook`, `changes`, `review`, `code`, `tasks`), the state the client sends for them, and the read only actions it takes: `select`, `textDiff`, `review` and `step` (plays a step of a session's playbook) |
| `diffMessage(repo, request)`, `openMessage(repo, request)` (`@appling/inspect/host-requests`) | Check a client's request for a text diff or to open a file against the repo: undefined unless the paths stay inside the repo (a file to open may also lie next to it, such as a generated project) and the revision or lines are plain |

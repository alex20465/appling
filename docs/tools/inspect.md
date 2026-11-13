---
title: Inspect
description: The read only inspector of an Appling model, with the model canvas as its main area and a floating inspector for the selected element, to debug and inspect the model.
---

Inspect is the companion you keep open next to an AI coding tool such as Claude Code, Codex or opencode. The agent changes the model and works through the generated project's tasks; the inspector shows what it does, live and read only. It draws the model as a tree you unfold, marks every change the moment it lands on disk, lays the agent's registry tasks out as a board of pending, in progress and done, and opens a floating inspector for the node you select: what it does, who may run it and where it is used. It never writes a model file. You and your agent edit the text; the inspector watches the files and keeps every node up to date.

The agent can drive it too. Through its [MCP server](ai.md#mcp-server) an [agent session](ai.md#agent-sessions) reads what you look at with `ide_context`, selects, reveals and highlights nodes with `ide_act`, and draws its own views and notes on the canvas with the [visual tools](ai.md#visual-tools).

Every repo gets its own inspector, served by a server that runs for that repo. In VS Code the [Appling extension](vscode.md) shows it in a tab per project, with its panels in the Appling sidebar. With only the command line installed, [`appling inspect`](cli.md#inspect) opens it in your browser:

```sh
npx appling inspect models
```

> [!TIP]
> To try the inspector without installing anything, open the [demo](https://appling.tools/inspect/). It runs on the sample sales and CRM model entirely in your browser.

The header shows the workspace folder, the release indicator (once a release exists) and either `valid` or the number of errors in the model.

In VS Code, **Appling: Show in the inspector** selects the element at the cursor of a `.appling` editor on the canvas, and **Open source** in the inspector opens an element's source in VS Code.

## The model canvas

The canvas draws the model as a tree that grows from a seed at the bottom, and it shows only what you unfold. The tabs at its top left choose the lens, the kinds of declarations the tree starts from:

| Lens | Starts from |
|---|---|
| Domain | Entities, value types and enums |
| Behavior | Actions, events, state machines and jobs |
| Application | Queries, projections, external systems and use cases |
| Interfaces | APIs, pages, navigations, flows and messages |
| Access | Roles, actors and tenants |

The tree unfolds one level per click, following the dependencies of the [semantic graph](../reference/graph.md) from what is used to what uses it:

1. The seed holds the modules that declare something of the lens.
2. A module holds its declarations of the lens, one bud per kind (such as `4 ENTITIES`) when there is more than one kind.
3. A declaration holds the declarations that use it, by kind again: an entity unfolds into its actions, queries, projections, machines and the pages that show it; an action into the machines, jobs, use cases, APIs and pages that run it.

Each circle has the color of its layer and the number of nodes it unfolds into. Next to it are the name, the kind and one fact that places it, such as `29 fields · 26 actions on it` for an entity, `on Order · draft, placed → cancelled` for an action, `every 0 3 * * * · runs Cancel` for a job or `/cms/quotes` for a page. A declaration from another module carries its qualified name. A declaration that already appears lower on its branch shows `↺` and does not unfold again. More than four declarations wrap into rows. A declaration keeps its place when it unfolds, and so do the ones beside it: where its children would meet others, they grow on a longer stem above them, so a tree of many open declarations grows in height as well as in width. Declarations stand in the order of their relevance, equally relevant ones by name.

The [relevance](../language/relevance.md) of a declaration decides how it is drawn: the more relevant, the larger its circle and the closer to the middle of its row, while the least relevant sit small at the edges. `core` declarations have a stronger ring and a bolder name, `peripheral` ones are faded until you point at them.

Clicking a circle unfolds it and selects it: the inspector opens over the right side of the canvas and shows what it does, who may run it and where it is used, and every link there selects the next element. Clicking the selected declaration again folds it: what it held shrinks back into it. The canvas moves to keep what you unfolded in view. What stands stays where it is: new shoots go above their node, and where two crowns would meet, both lean out to their side instead of pushing the nodes below apart.

The tree is drawn as a plant. New shoots come out of the bud on top of the node you clicked, one after another, each on a stem that carries leaves and is thicker the more grows from it. Sap runs up the stems from the seed to the current node. A wave of rings spreads from a node when you unfold or fold it, and from every drawn element that a new version of the model added (green) or changed (blue), whether you, your editor or an agent session wrote the change. With reduced motion set in your system, the plant stands still and has no waves.

With a server, the canvas also shows how far the code is: each declaration and module has a dot in the colour of its [implementation state](implementation.md#implementation-states) and a tag in words under its labels (`implemented`, `partly implemented`, `not implemented`, `code moved` or `code missing`); one that has no code yet is drawn hollow. The inspector does not generate: run [`appling generate`](cli.md#generate), and the marks follow.

- The path at the top left leads from the seed to the current node; click a step to go back to it.
- The line at the top right describes the current node, such as `quotes.Quote · entity · core · 29 fields · 26 actions on it · used by 84`.
- At the bottom, **link entities** adds [link entities](../language/domain.md#link-entities) such as join records, which are left out by default. The zoom level, **−** and **+** zoom, **Tasks** opens the [task board](implementation.md#registry-tasks-and-agent-sessions) with the count of open tasks, **Fit** shows the whole tree, and **Replant** folds it back to the seed. **Legend** explains every mark: the code states, the change badges, buds, `↺`, claim rings and relevance. **Sound on** or **Sound off** switches the soft notes the plant plays: a rising run when shoots unfold, two falling notes on a fold and a short chime when the model changes. The choice is kept in your browser, and the first sound waits for your first click. Drag to pan and scroll to zoom.

The lens and the link entities option are saved in `.appling/view.json` in the workspace folder, so the view opens the same way next time.

## Selection

Selection is shared between the canvas, the inspector and the host's editor:

- Clicking a circle, a module or a link in the inspector selects that element and opens the inspector.
- **Appling: Show in the inspector** in a `.appling` editor of VS Code selects the innermost element at the cursor. When the lens starts from the kind of the declaration that contains it, the canvas unfolds its module and marks it.

## The inspector

The inspector floats over the right side of the canvas while an element is selected; **×** closes it and clears the selection. It shows the selected element: its kind and layer, its qualified name (with **Open source** where the host has an editor, such as VS Code, which opens its declaration there), and

- **What it does**, for an action: the entity it works on, its inputs, what it requires (with the error raised otherwise), what it changes (its own effects, then each machine transition it drives with that transition's effects), its errors and its consistency,
- **Actions**, for an entity: the actions declared on it, each with the machine transitions it drives, such as `draft, placed -> cancelled`, followed by the actions elsewhere that create its records, marked `creates`,
- **What they can do**, for an actor: what this person may do, by the [simulator](simulator.md#how-it-decides), in five groups: Actions, Pages, Use cases, Queries and Data (each entity operation, and fields that a policy guards separately). Only what the actor may do is listed: each entry says `may` or `depends on the data` and lists the policies that decide it with their conditions. What the actor is refused is left out, and so is a group with nothing allowed. A page also lists the actions it offers that the actor may use, because seeing a page does not mean being allowed to use its buttons,
- **line**, when the cursor of a `.appling` editor or a code link selected a declaring line that is no element, such as a use case step, a handler, a `requires`, a page component, a navigation item or a message: its [sub-anchor](../reference/graph.md#sub-anchors) (`#step[2]`). The canvas shows its element,
- its change, while the canvas marks the element as added, changed or removed (as a live change or by the review of the VS Code extension), with the properties that differ,
- **Members**: the elements inside it, one line each, such as `status: OrderStatus state` for a field,
- **Used by**: every declaration that references the element or one of its members, grouped by layer. For an entity this is the overview of its behavior and use: the events, actions, machines and jobs in Behavior, the queries, projections and use cases in Application, the endpoints in Interfaces and the pages in Experience,
- **Uses**: every declaration the element or one of its members references, grouped by layer.

Used by and Uses lift each reference to its top level declaration and say which members it runs through. For the field `sales.Order.placed_at`, Used by shows `sales.PlaceOrder action via effect[set placed_at]` and `sales.OpenOrders query`, which sorts by it. For the action `sales.PlaceOrder`, it shows `sales.OrderFlow machine via transition[draft->placed]`, `sales.PublicApi interface via endpoint[POST /orders/{id}/place]` and the page `sales.OrderDetail`. For Uses, the members are the element's own: the entity `sales.Order` uses `crm.Account` via `customer`. Every entry is a link that selects that element.

For an action the inspector also shows **Who may trigger it**, each actor that may trigger it with `may` or `depends on the data`, and **Invariants at risk**, the invariants that read a field the action changes. For a machine it shows **Reachable states**, each state with the triggers of the shortest path to it. The [simulator](simulator.md) answers both.

The inspector has no fields to edit, no menu and no buttons that change the model.

## Reviewing changes

The **Review** panel of the [VS Code extension](vscode.md#the-panels) shows what changed in a workspace that lives in a git repository. By default it compares the working tree with `HEAD`, so you see the uncommitted changes; the picker on top compares it with any of the latest 50 commits that touch the workspace folder instead.

- **Model** lists the elements that were added, changed or removed, by qualified name. A changed element names the properties that differ and how many of its references changed. A rename recorded as a migration step (see [Migrations](../language/migrations.md)) shows as one change with its old name, not as a removal and an addition. Click an element to select it on the canvas; **text diff** shows the element's text at the commit and now.
- **Files** lists every file of the workspace folder that differs from the commit, `.appling` or not: added (A), modified (M), deleted (D), renamed (R) and untracked (U). Click one for its text diff.
- **mark on the canvas** (on by default) marks the changes on the canvas: added declarations glow green, changed ones and the modules that hold changes glow yellow, and removed declarations are drawn ghosted with a dashed circle where they were.

The panel follows every change on disk. The server reads git with the git CLI: `git ls-tree` and `git show` for the `.appling` files at the commit, which it builds into a graph the same way as the working tree, and `git diff --name-status` plus `git status --porcelain` for the changed files. A folder outside git shows a message instead. Its text diffs open in VS Code's diff editor.

| Endpoint | Returns |
|---|---|
| `GET /api/diff?rev=HEAD` | `{ ok, rev, commit, files, diff, before }`: the changed files, the model diff (`diffGraphs` of `@appling/model/diff`) and the model at the commit (graph, files, locations); `{ ok: false, error }` outside git or for an unknown revision |
| `GET /api/revisions` | The latest commits that touch the workspace folder |

## The task board

Generating a project leaves a [registry task](../codegen/registry.md) for every part the generator could not write, and your agent works through them with `registry_next`. **Tasks** at the bottom of the canvas, with the count of open tasks, lays the board over the canvas in three groups, each in plan order:

| Group | Holds |
|---|---|
| In progress | Tasks whose element an agent session claimed, with the session's name in its colour |
| Pending | Open tasks no session claimed yet |
| Done | Finished tasks |

Each task shows the element's qualified name and kind, `partly written` when the generator wrote part of it, the first thing it still misses and its attempts (and its target, with more than one). Click a task to select its element: the canvas unfolds to it and the inspector opens. The board follows the registries on disk, so a task moves from pending to in progress to done as the agent claims and finishes it. See [Registry tasks and agent sessions](implementation.md#registry-tasks-and-agent-sessions).

The inspector does not generate. Run [`appling generate`](cli.md#generate) or let your agent do it; the marks and the board follow. The **Code** panel of the [VS Code extension](vscode.md#the-panels) also lists the count of elements per [implementation state](implementation.md#implementation-states), the targets of `appling.config.json` and the elements changed since the last generation.

## Live changes

Every change to the model is marked on the canvas the moment it lands on disk, whoever wrote it: an [agent session](ai.md#agent-sessions) through the MCP tools, an agent or editor that writes the files directly, `appling fmt` or a `git checkout`. Each changed node gets a pulsing halo, a letter on its circle as Source Control marks files (A added, M changed, D removed) and its name in the change's colour: added declarations green, changed ones and the modules that hold them blue, removed declarations red and dashed, drawn ghosted where they were. Marking never moves the camera and never unfolds the tree: what you look at stays where it is.

The changes are compared with the model files at git `HEAD`, the same commit `git status` compares with, so the canvas marks what git shows as changed: everything since the last commit, by you or your agent. The server watches the repository's git folder and follows `HEAD`: after a commit, a checkout or a reset the marks start again from the new commit. Outside a git repository, or before the first commit, the baseline is the model files on disk when the server started, so only what changes while you look is marked; the first commit then makes `HEAD` the baseline.

The **Changes** panel of the [VS Code extension](vscode.md#the-panels), with the count of changed files on its badge, lists them per file, newest first:

- the file with its status (A added, M modified, D deleted), the agent sessions whose tool calls wrote it in their colour, or **written to disk** for any other writer, and when it last changed,
- the model changes in the file: the elements added, changed (with the properties that differ) or removed; click one to select it,
- **text diff**: the file at `HEAD` (or the baseline outside git) and now.

While the Review panel marks its own diff on the canvas, the review's marks replace the live ones.

### Agent views

The [visual tools](ai.md#visual-tools) of the repo's agent sessions draw on this canvas, and `ide_act` selects (`open`, `reveal`) or highlights its nodes. A view a session shows, with its bubbles, its current step and its last reply, waits as a chip at the top right of the canvas under the session's name and colour. Click it to open the view: the canvas draws the session's tree, flowchart or cards, one bubble at a time with Back and Next, and follows each new view and bubble of that session; **Back to the model** returns to your own tree. A [playbook](ai.md#playbooks) lists its steps above the canvas (in VS Code, in the Playbook view of the sidebar); each step selects its element under the lens of its layer. Nothing opens by itself and nothing plays on a timer. The field under the view's bar sends the session a question: it reaches the session's inbox as a message from User, stays listed in the view, and the session's answer (`visual_reply`) shows below it.

When a session ends, its views go.

## Releases and migration steps

Once the workspace has a release (`appling release 1.0.0`, see [CLI](cli.md#release)), the header shows a button such as `release 1.0.0 · 2 migration step(s) since`. It counts the steps in the `since_v1_0_0` blocks of all modules; click it to select the first such block.

Renaming, retyping or removing a released domain element through the [edit operations](../reference/edit-operations.md#release-aware-edits), such as an agent's `edit` tool, appends the matching migration step automatically. The inspector reads the latest release when it loads; reload it after creating a release.

## Live updates

The server watches the workspace folder for changes to `.appling` files (ignoring hidden folders and `node_modules`), to `appling.config.json`, `.appling/references.json`, `.appling/generation.json` and the registries of the generate targets inside the folder, and pushes a new snapshot to the view about 100 ms after the last change. Edits from your editor, `appling fmt` or an AI agent through the [MCP server](ai.md#mcp-server) appear without a reload.

The canvas also marks what [agent sessions](ai.md#agent-sessions) of the repo claimed or highlighted: a dashed ring in the session's colour around the declaration, with the session's label in its tooltip. In [VS Code](vscode.md#agent-sessions) a click on the ring goes to the session's terminal.

## Theme

The inspector's colours and fonts are CSS variables on the page's root, so a host can replace any of them: `--appling-surface`, `--appling-surface-raised`, `--appling-surface-elevated` and `--appling-surface-hover` (backgrounds), `--appling-line` and `--appling-line-strong` (borders), `--appling-ink`, `--appling-ink-soft` and `--appling-ink-muted` (text), the accents `--appling-leaf`, `--appling-sprout`, `--appling-rust`, `--appling-amber` and `--appling-copper`, `--appling-info`, `--appling-danger` and `--appling-shadow`, the canvas's `--appling-canvas-glow`, `--appling-root`, `--appling-branch` and `--appling-seed`, the change colours `--appling-change-added`, `-changed` and `-removed`, the layer colours `--appling-layer-domain`, `-behavior`, `-application`, `-interface`, `-experience` and `-cross`, and `--appling-font-sans` and `--appling-font-mono`.

The inspector is dark. `data-theme="light"` on the root picks its light palette. A host that embeds it with `?host=frame` sends `{ type: 'theme', kind: 'light' | 'dark', tokens }` to the frame: the kind sets `data-theme` and the tokens replace the inspector's own, until the next theme message. The [VS Code extension](vscode.md#theme) sends VS Code's theme this way, at first and on every change.

## Security

Each repo's inspector server is meant for your machine only:

- It listens on `127.0.0.1` only, never on other interfaces.
- Every request and websocket must carry a `Host` header of `127.0.0.1:<port>` or `localhost:<port>`, and an `Origin` header, when present, must be one of `http://127.0.0.1:<port>` and `http://localhost:<port>`. Anything else gets `403 Forbidden`. This blocks other websites and DNS rebinding.
- It writes no model file; the only file it writes is `.appling/view.json` with the canvas settings.
- Its page may be embedded only by itself and by VS Code's webviews and the VS Code window that holds them (`Content-Security-Policy: frame-ancestors 'self' vscode-webview: vscode-file: https://*.vscode-cdn.net`). An app that started the server over IPC may add one trusted origin at a time with `{ type: "trust", origin }`, such as the VS Code extension for a port forwarded from a remote window.

The server endpoints, for reference:

| Endpoint | Does |
|---|---|
| `GET /api/snapshot` | Files, graph, dependencies, source locations, code references and errors |
| `GET`, `PUT /api/view` | Reads and writes `.appling/view.json` |
| `GET /api/release` | Version and date of the latest release, or `null` |
| `POST /mcp` | The repo's MCP server for [agent sessions](ai.md#agent-sessions); needs a session's bearer token |
| `GET`, `POST /api/sessions` | Lists the agent sessions, opens one (returns its token and the MCP URL) |
| `PATCH`, `DELETE /api/sessions/<id>` | Renames a session or sets its status, ends it |
| `POST /api/sessions/<id>/ask` | Delivers `{ text }`, a question typed in the session's view, to its inbox |
| websocket `/events` | Snapshot pushes on file changes, the live changes (`live`), the agent sessions, their `ide_act` actions and views (`agent-view`); the client reports its selection, its view settings and the agent view it shows |

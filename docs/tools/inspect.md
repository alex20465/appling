---
title: Inspect
description: The read only inspector of an Appling model, with the model canvas as its main area and an inspector sidebar for the selected element, to debug and inspect the model.
---

Inspect is the companion you keep open next to an AI coding tool such as Claude Code, Codex or opencode. The agent changes the model and works through the generated project's tasks; the inspector shows what it does, live and read only. It draws the model as a pyramid of five levels you unfold, marks every change the moment it lands on disk, lays the agent's registry tasks out as a board of pending, in progress and done, and opens an inspector beside the canvas for the node you select: what it does, who may run it and where it is used. It never writes a model file. You and your agent edit the text; the inspector watches the files and keeps every node up to date.

The agent can drive it too. Through its [MCP server](ai.md#mcp-server) an [agent session](ai.md#agent-sessions) reads what you look at with `ide_context`, selects, reveals and highlights nodes with `ide_act`, and draws its own views and notes on the canvas with the [visual tools](ai.md#visual-tools).

Every repo gets its own inspector, served by a server that runs for that repo. In VS Code the [Appling extension](vscode.md) shows it in a tab per project, with its panels in the Appling sidebar. With only the command line installed, [`appling inspect`](cli.md#inspect) opens it in your browser:

```sh
npx appling inspect models
```

> [!TIP]
> To try the inspector without installing anything, open the [demo](https://appling.tools/inspect/). It runs on the sample sales and CRM model entirely in your browser. Its [stories page](https://appling.tools/inspect/stories.html) shows one angle of each view on the same model.

The header shows the workspace folder, the release indicator (once a release exists) and an icon for the state of the model: a check mark when it is valid, a warning sign with the number of errors otherwise. Pointing at it says so in words and lists the first errors. At the bottom right, "sponsored by Techthos.net" links to the sponsor, https://www.techthos.net/.

**Show** in the header picks how much of the model every view draws, by [relevance](../language/relevance.md): **Core** (the default) draws only what the business runs on, **Supporting** and **Peripheral** add the next levels, **Everything** adds the internals. An actor that starts a drawn use case is drawn whatever its own relevance, and so is what an agent shows. The choice is saved in `.appling/view.json` as `relevance`.

The view rail on the left switches between the four views of the model: **Levels**, the [model canvas](#the-model-canvas), and the [diagrams](#diagrams) **Use cases**, **States** and **Screens**. Pointing at an icon shows its name and the question the view answers; the keys 1 to 4 switch too. On a phone the rail is a bar at the bottom. The chosen view is saved in `.appling/view.json`, so the inspector opens on it next time.

In VS Code, **Appling: Show in the inspector** selects the element at the cursor of a `.appling` editor on the canvas, and **Open source** in the inspector opens an element's source in VS Code.

## The model canvas

The canvas draws the model as a pyramid of five horizontal bands, one per level, and it shows only what you unfold. Each level answers one question:

| Level | Question | Holds |
|---|---|---|
| L5 Access | Who can do what? | Roles, actors and tenants |
| L4 Interfaces | What is exposed and where? | APIs, pages, navigations, flows and messages |
| L3 Application | How is it exposed? | Queries, projections, external systems and use cases |
| L2 Behavior | What can happen? | Actions, events, state machines and jobs |
| L1 Domain | What exists? | Entities, value types and enums |

L5 stands on top and L1 at the bottom. The yellow labels **L1** to **L5** at the left edge, each beside its band, choose the entry level: the level whose declarations the pyramid starts from. The label of the entry level is brighter. Pointing at a label shows its question and how many declarations the level holds. Pick the level that matches your question: L5 to see who can do what, L1 to see what exists and what rests on it, a level in between to walk both ways.

The band of the entry level holds one frame per module that declares something of that level. A folded module is a chip; clicking it opens the frame with its declarations of the entry level, and clicking its name folds it again. With up to three modules the frames start open.

Every declaration unfolds in two directions, following the references of the [semantic graph](../reference/graph.md):

- The tab on top unfolds what rests on it: the declarations of higher levels that use it. An entity unfolds into its actions, queries and projections and the roles its policies name; an action into the use cases, APIs and pages that run it.
- The tab below unfolds what it rests on: the declarations of lower levels it uses. A page unfolds into its queries, projections and actions; a query into its entity.

Each chip unfolds through a small tab with an arrow on its top and its bottom edge. A declaration of L1 has only the tab on top, one of L5 only the tab below, and a tab shows only where something is. What unfolds stands in the band of its own level, however many bands away: a query reads its entity directly, so the entity stands in L1 and its trace crosses the band of L2. Away from the entry level a branch keeps its direction: what you unfolded upwards unfolds further up, what you unfolded downwards further down. To walk the other way from such a declaration, make its level the entry level. Clicking the tab of an open side, its arrow turned around, folds that side again.

A role, actor or tenant leads down through the pages and interfaces that expose what its policies name; an actor may what its roles may, and a query asks for what its entity allows. What such a page or interface already exposes shows under it, not a second time under the role. Scenarios and migrations are outside the pyramid.

Each node is a chip: a box of one size, with a cell on its left in the color of its layer, which holds its icon when it has one. Right of the cell are the name, the kind and one fact that places it, such as `29 fields · 26 actions on it` for an entity, `on Order · draft, placed → cancelled` for an action, `every 0 3 * * * · runs Cancel` for a job or `/cms/quotes` for a page. A declaration from another module carries its qualified name. A declaration is drawn exactly once: where an unfolded node also leads to one that is drawn elsewhere already, a trace joins the two, and it lights up when either end is the current node. Every declaration owns the strip above and below it and stands in the middle of it, so unfolding one moves the ones beside it aside. The declarations of one level wrap into a grid, so a band grows by rows. Unfolding never reorders: a declaration keeps its row and its place in it, and what it unfolds stands in a strip beside the grid. Declarations stand in the order of their level, the nearest first, then by kind, then by their [relevance](../language/relevance.md), equally relevant ones by name.

`core` declarations have a stronger outline, a stronger color in their cell and a bolder name, `peripheral` ones are faded until you point at them.

Clicking a chip selects it: the inspector opens beside the canvas and shows what it does, who may run it and where it is used, and every link there selects the next element. The declarations of its own level it belongs together with, such as the machine an action drives or the role of an actor, get a dashed outline when they are drawn; relations inside one level do not unfold. The canvas moves to keep what you unfolded in view.

The pyramid is drawn as a circuit board that grows like a plant. New nodes come out of the edge you unfolded, one after another, each on a trace in the color of the level it starts from. A trace runs in straight lines with 45 degree corners. All that a node leads to on one side leaves the middle of that edge as one line, runs on a track of its own before each row it ends in and ends at a place of its own on the edge of each chip. No trace runs through a node and no two lines share a stretch; they cross at right angles only, as rarely as the connections allow. Rows and bands move apart as far as their traces need. With a node selected, its connections stand out and the rest fades. A wave of rings spreads from a node when you unfold or fold it, and from every drawn element that a new version of the model added (green) or changed (blue), whether you, your editor or an agent session wrote the change. With reduced motion set in your system, the plant stands still and has no waves.

With a server, the canvas also shows how far the code is: the outline of each declaration's and module's chip tells its [implementation state](implementation.md#implementation-states): solid when implemented, dashed when partly, faint dots when not. Pointing at the chip names the state in words. A declaration with an [annotation](../language/descriptions.md) carries a note in the top right corner of its chip; pointing at the note shows the keyword and the text. The inspector does not generate: run [`appling generate`](cli.md#generate), and the marks follow.

- The toolbar at the bottom right holds the zoom level with its minus and plus buttons and **Fit**, which shows the whole pyramid. Next to them, **Tasks** opens the [task board](implementation.md#registry-tasks-and-agent-sessions) with the count of open tasks and **Legend** explains every mark: the code states, the change badges, the levels, the unfold arrows, the dashed outline, claim rings, the annotation note and relevance. Pointing at a button names it.
- **View settings**, the last button, opens the visual options. **Link entities** adds [link entities](../language/domain.md#link-entities) such as join records, which are left out by default. **Sound** switches the soft notes the canvas plays: a rising run when declarations unfold, two falling notes on a fold and a short chime when the model changes. The choice is kept in your browser, and the first sound waits for your first click. **Replant** folds the pyramid back to the modules of the entry level. Drag to pan and scroll to zoom; on a touch screen, drag with one finger and pinch with two. On a narrow screen the inspector opens below the canvas instead of beside it.

The entry level, the link entities option and the chosen view are saved in `.appling/view.json` in the workspace folder, so the view opens the same way next time.

A node can carry an icon from the [Lucide](https://lucide.dev/icons) catalog, in the middle of its cell. Icons are set by an AI assistant with the [`set_icons`](ai.md#view-tools) tool of the MCP server, for a kind (every declaration of that kind), or for one module or declaration. They are kept under `icons` in `.appling/view.json`, which you can also edit by hand, and appear on every open canvas the moment the file changes.

## Diagrams

The diagrams draw the same model regardless of levels, each built from the whole model and each a view of its own on the rail. Clicking an element in a diagram selects it and opens the [inspector](#the-inspector), as on the canvas. Each plays a short intro when it appears.

| View | Draws |
|---|---|
| Use cases | A use case diagram in the chips of the canvas: one dashed system boundary for the whole application, the declared actors left of it, and the use cases inside it. A curve joins an actor to every use case it starts: the use case names the actor or one of its roles after `by`, or in a policy. A `step` always runs what it calls, so it draws a dashed include arrow: to another use case, which stands right below, or to an action, drawn as an action chip to the right. Error handlers and the timeout of an `await` run only in a special case and are not drawn. Selecting an element lights its lines |
| States | A UML state diagram of the machine you pick in the dropdown at the top left: the initial pseudostate pointing at the state of the field's default, rounded states, final states with a double border, and every transition as a curve labelled with the action or event that drives it, its guard and the jobs that run it. The diagram runs top down: the initial state on top, every state below the states that lead to it, the states nothing leaves at the bottom. Transitions between the same two states are one curve with all their triggers, and one that leads back up is dashed. A trigger that leads into one state from four states or more, such as a cancel, is one short arrow beside that state which says from how many states it comes; pointing at it lists them. A trigger that leads into three states or more, such as a rollback, is drawn the same way and does not decide the order |
| Screens | A clickable mockup of the application as the actor you pick sees it, in a browser window with the route of the open page. The app bar holds the navigations as the main menu, cut to the pages the actor reaches, and the actor as the signed in account, whose dropdown switches to another actor. A page shows its components: a list as a table with the row actions the actor may run and rows that open the page detailing the same entity, a detail as a card of fields with its actions, the most relevant ones as buttons and the others behind a **more** menu, a form with the inputs of the action it submits. A page of a [flow](../language/experience.md) of a use case the actor starts shows the step it is and a button that continues to the next page. A page that no navigation names stands below the page its route lies under, such as `/admin/users` below `/admin`, as sub navigation with one row per level; pages without such a parent stand under **More**. Clicking a title or a button selects its element of the model. APIs are not shown |

A diagram with nothing to draw names the declarations that would fill it, such as a `machine` for States, or says that nothing is relevant enough for the level shown.

## Selection

Selection is shared between the canvas, the inspector and the host's editor:

- Clicking a node or a link in the inspector selects that element and opens the inspector.
- **Appling: Show in the inspector** in a `.appling` editor of VS Code selects the innermost element at the cursor. When the declaration that contains it is of the entry level, the canvas opens its module and marks it.

## The inspector

The inspector is a sidebar over the full height at the right of the canvas while an element is selected; **×** closes it and clears the selection. It shows the selected element: its kind and layer, its qualified name (with **Open source** where the host has an editor, such as VS Code, which opens its declaration there), and

- **Describe** and the [annotation](../language/descriptions.md) of the element's level (`holds`, `does`, `handles`, `serves` or `shows`), when it has them: the notes of the model in its own words, the annotation marked as work for the code that the model does not state,
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

## Comparing with a revision

For a host that shows what changed since a commit, the server compares a workspace in a git repository with any revision. It reads git with the git CLI: `git ls-tree` and `git show` for the `.appling` files at the commit, which it builds into a graph the same way as the working tree, and `git diff --name-status` plus `git status --porcelain` for the changed files. A rename recorded as a migration step (see [Migrations](../language/migrations.md)) shows as one change with its old name, not as a removal and an addition.

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

The inspector does not generate. Run [`appling generate`](cli.md#generate) or let your agent do it; the marks and the board follow.

## Live changes

Every change to the model is marked on the canvas the moment it lands on disk, whoever wrote it: an [agent session](ai.md#agent-sessions) through the MCP tools, an agent or editor that writes the files directly, `appling fmt` or a `git checkout`. Each changed node gets a halo, a letter on its chip as Source Control marks files (A added, M changed, D removed) and its name in the change's colour: added declarations green, changed ones and the modules that hold them blue, removed declarations red and dashed, drawn ghosted where they were. Marking never moves the camera and never unfolds the pyramid: what you look at stays where it is.

The changes are compared with the model files at git `HEAD`, the same commit `git status` compares with, so the canvas marks what git shows as changed: everything since the last commit, by you or your agent. The server watches the repository's git folder and follows `HEAD`: after a commit, a checkout or a reset the marks start again from the new commit. Outside a git repository, or before the first commit, the baseline is the model files on disk when the server started, so only what changes while you look is marked; the first commit then makes `HEAD` the baseline.

The **Changes** panel of the [VS Code extension](vscode.md#the-panels), with the count of changed files on its badge, lists them per file, newest first:

- the file with its status (A added, M modified, D deleted), the agent sessions whose tool calls wrote it in their colour, or **written to disk** for any other writer, and when it last changed,
- the model changes in the file: the elements added, changed (with the properties that differ) or removed; click one to select it,
- **text diff**: the file at `HEAD` (or the baseline outside git) and now.

While a host marks a revision's diff on the canvas, its marks replace the live ones.

### Agent views

The [visual tools](ai.md#visual-tools) of the repo's agent sessions draw on this canvas, and `ide_act` selects (`open`, `reveal`) or highlights its nodes. A view a session shows, with its bubbles, its current step and its last reply, waits as a chip at the top right of the canvas under the session's name and colour. Click it to open the view: the canvas draws the session's pyramid, flowchart or cards, one bubble at a time with Back and Next, and follows each new view and bubble of that session; **Back to the model** returns to your own pyramid. A [playbook](ai.md#playbooks) lists its steps above the canvas (in VS Code, in the Playbook view of the sidebar); each step selects its element with the level of its kind as the entry level. Nothing opens by itself and nothing plays on a timer. The field under the view's bar sends the session a question: it reaches the session's inbox as a message from User, stays listed in the view, and the session's answer (`visual_reply`) shows below it.

When a session ends, its views go.

## Releases and migration steps

Once the workspace has a release (`appling release 1.0.0`, see [CLI](cli.md#release)), the header shows a button such as `release 1.0.0 · 2 migration step(s) since`. It counts the steps in the `since_v1_0_0` blocks of all modules; click it to select the first such block.

Renaming, retyping or removing a released domain element through the [edit operations](../reference/edit-operations.md#release-aware-edits), such as an agent's `edit` tool, appends the matching migration step automatically. The inspector reads the latest release when it loads; reload it after creating a release.

## Live updates

The server watches the workspace folder for changes to `.appling` files (ignoring hidden folders and `node_modules`), to `appling.config.json`, `.appling/generation.json`, the registries of the generate targets inside the folder and the [`@appling` markers](references.md#the-marker) in code files (a code file counts only when its markers change), and pushes a new snapshot to the view about 100 ms after the last change. Edits from your editor, `appling fmt` or an AI agent through the [MCP server](ai.md#mcp-server) appear without a reload.

The canvas also marks what [agent sessions](ai.md#agent-sessions) of the repo claimed or highlighted: a dashed ring in the session's colour around the declaration, with the session's label in its tooltip. In [VS Code](vscode.md#agent-sessions) a click on the ring goes to the session's terminal.

## Theme

The inspector's colours and fonts are CSS variables on the page's root, so a host can replace any of them: `--appling-surface`, `--appling-surface-raised`, `--appling-surface-elevated` and `--appling-surface-hover` (backgrounds), `--appling-line` and `--appling-line-strong` (borders), `--appling-ink`, `--appling-ink-soft` and `--appling-ink-muted` (text), the accents `--appling-leaf`, `--appling-sprout`, `--appling-rust`, `--appling-amber` and `--appling-copper`, `--appling-info`, `--appling-danger` and `--appling-shadow`, the canvas's `--appling-canvas-glow`, `--appling-root`, `--appling-branch` and `--appling-seed`, the change colours `--appling-change-added`, `-changed` and `-removed`, the layer colours `--appling-layer-domain`, `-behavior`, `-application`, `-interface`, `-experience` and `-cross`, and `--appling-font-sans` and `--appling-font-mono`.

The inspector is dark. `data-theme="light"` on the root picks its light palette. A host that embeds it with `?host=frame` sends `{ type: 'theme', kind: 'light' | 'dark', tokens }` to the frame: the kind sets `data-theme` and the tokens replace the inspector's own, until the next theme message. The [VS Code extension](vscode.md#theme) sends VS Code's theme this way, at first and on every change.

## Security

Each repo's inspector server is meant for your machine only:

- It listens on `127.0.0.1` only, never on other interfaces.
- Every request and websocket must carry a `Host` header of `127.0.0.1:<port>` or `localhost:<port>`, and an `Origin` header, when present, must be one of `http://127.0.0.1:<port>` and `http://localhost:<port>`. Anything else gets `403 Forbidden`. This blocks other websites and DNS rebinding.
- It writes no model file; the only file it writes is `.appling/view.json` with the canvas settings. The icons in that file are written by the `set_icons` tool, not by the inspector.
- Its page may be embedded only by itself and by VS Code's webviews and the VS Code window that holds them (`Content-Security-Policy: frame-ancestors 'self' vscode-webview: vscode-file: https://*.vscode-cdn.net`). An app that started the server over IPC may add one trusted origin at a time with `{ type: "trust", origin }`, such as the VS Code extension for a port forwarded from a remote window.

The server endpoints, for reference:

| Endpoint | Does |
|---|---|
| `GET /api/snapshot` | Files, graph, dependencies, source locations, code references and errors |
| `GET`, `PUT /api/view` | Reads and writes `.appling/view.json`; a `PUT` keeps the icons on disk |
| `GET /api/release` | Version and date of the latest release, or `null` |
| `POST /mcp` | The repo's MCP server for [agent sessions](ai.md#agent-sessions); needs a session's bearer token |
| `GET`, `POST /api/sessions` | Lists the agent sessions, opens one (returns its token and the MCP URL) |
| `PATCH`, `DELETE /api/sessions/<id>` | Renames a session or sets its status, ends it |
| `POST /api/sessions/<id>/ask` | Delivers `{ text }`, a question typed in the session's view, to its inbox |
| websocket `/events` | Snapshot pushes on file changes, the live changes (`live`), the agent sessions, their `ide_act` actions and views (`agent-view`), the view settings after `.appling/view.json` changed on disk (`view`); the client reports its selection, its view settings and the agent view it shows |

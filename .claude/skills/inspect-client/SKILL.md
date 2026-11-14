---
name: inspect-client
description: How the Appling inspector client (packages/inspect) draws the own SVG model tree, the floating inspector and the task board, and how snapshots, live marks and selection flow between server and client. Use when changing the model canvas (tree, layout, relevance drawing), the inspector, the task board, the /events websocket, or when debugging stale graph state, lost selection or clicks that miss.
---

# Inspector client

Internal flows of the read only inspector client that are not visible from one file.

## Snapshot and selection

The canvas, the inspector and the selection read only the snapshot, which the server builds from disk and pushes over `/events` after every change (100ms debounce of the file watcher). The client never writes a model file; the only write is `PUT /api/view` for the canvas settings. Selection is client state: a node click, a link in the inspector, an `ide_act` of an agent session, a host's panel action or the cursor of a `.appling` editor sent by the host set it, and **×** on the inspector clears it. A selected sub-anchor address (`sales.Checkout#step[2]`) shows its owning element. Source: `App.tsx`, `Inspector.tsx`, `server.ts`.

## The model tree

`growTree` (`packages/viz/src/views.ts`) rebuilds the whole tree from the graph and the `unfolded` id set on every change; nothing else holds tree state. Only `ViewSettings` (`lens`, `linkEntities`) persist, through `/api/view` in `.appling/view.json`, merged over `DEFAULT_VIEW` on load; the unfolded set and the camera do not. Node ids are paths: the seed `~`, a module `~/<module>`, a group `<parent>/#<Kind>`, an element `<parent>/<qn>`. The same declaration can therefore appear on several branches with different ids; `cycle` marks one already on its own path. Folding deletes the node's id and every id under it. Source: `views.ts`, `canvas/ModelCanvas.tsx`.

Children come from `relations(index, qn, 'usedBy')`, lifted to top level declarations, minus modules, minus link entities unless `linkEntities` is on. Declarations are sorted by `index.relevanceOf`, then kind rank, then qualified name (never by source order). Groups always come in the order of `KIND_ORDER`, whatever their members' relevance, so the same kinds stand in the same order on every node.

`layoutTree` (`layout.ts`) lays the tree out as a board on which traces cannot cross: every node owns the strip above it, as wide as all that grows from it (`sizeOf`), and stands below the middle of its first row. Up to `WRAP` children stand in one row; more wrap into about as many rows as columns (`linesOf`), each row above everything that grows from the row below, and each row split in two halves that leave `TRUNK` free between them. Groups keep their order left to right; declarations go through `centered()` (first in the middle, then alternating). So unfolding moves the nodes beside it aside and the rows above it upwards; nothing is stable but the order. A node's x is the middle of its chip, where the traces meet it; a slot (`SLOT`) holds the whole chip (`WIDE` and `HALF` in `ModelCanvas.tsx` must stay inside it, and texts are clipped to fit).

`traces` (`canvas/plant.ts`) draws one net per parent: the trunk straight up from the parent, and in the channel below each row of its children (`ROW / 2`) a branch to each child, corners cut at 45 degrees. No obstacle check is needed: the layout gives every net its own room and keeps the trunk free. Every trace has ten points, so the CSS `d` transition moves one into another; keep that count. Nodes are chips of one size per type (`outline`), with pins per side for the level of the layer (`LEVELS`) and a cell in the layer's colour that holds the node's icon (`ViewSettings.icons`, a Lucide name through `iconOf` of `icons.ts`, written by the `set_icons` MCP tool into `.appling/view.json`, which the server watches and pushes as a `view` event). Source: `layout.ts`, `canvas/plant.ts`, `ModelCanvas.tsx`.

## Pan, zoom and clicks

React registers `wheel` as passive, so the canvas adds its own non passive listener to stop page scroll. A drag starts on pointer down and counts as a pan only after 4px; pointer up clears the drag ref in a `setTimeout`, after the click handler had the chance to read `moved`, so a pan never unfolds a node. Stems are drawn through the CSS `d` property (`style={{ d: 'path(...)' }}`, Chromium only). A new node and its stem grow out of the parent's bud together: `stem-grow` starts from the collapsed path in `--seedling`, `sprout` from `--from-x`/`--from-y`, both with `--spring` and the delay of `sproutDelays` (`canvas/plant.ts`, also the traces and their thickness), so keep their timing equal or the node leaves its trace; the same holds for `--settle` on moved nodes and traces. Only the lit path animates forever (sap), to keep an idle canvas from repainting. `modelPulse` (`views.ts`) finds the drawn elements a new index added or changed for the waves; `canvas/sound.ts` synthesizes the sounds (Web Audio, started only by a press, switched off in `localStorage`). `follow` frames a node and its new children after the layout placed them, zooming out only when they do not fit. Source: `ModelCanvas.tsx`, `canvas.css`.

## Relevance

`GraphIndex` computes `relevance(graph)` once from `@appling/model/relevance` (the subpath keeps langium out of the browser bundle) and `relevanceOf(qn)` lifts members to their declaration. The canvas maps the score to the radius per node type and `relevanceLevel(score)` to the `core`/`supporting`/`peripheral` class for emphasis. Source: `packages/model/src/relevance.ts`, `views.ts`, `ModelCanvas.tsx`.

---
name: ide-client
description: How the Appling IDE client works with Monaco 0.57 (native LSP client) and the own SVG model tree, and how edits, snapshots and selection flow between client and server. Use when changing the editor, the model canvas (tree, layout, relevance drawing), the search, the inspector, the /lsp websocket, or when debugging stale graph state, lost selection, clicks that miss or LSP features that fail across files.
metadata:
  anchors:
    - name: monaco-editor
      version: 0.57.0
      researched: 2026-10-23
---

# IDE client

Version deltas and internal flows of the IDE client that are not visible from one file.

## Monaco's native LSP client

Since 0.55 Monaco ships an LSP client. The IDE connects with `monaco.lsp.WebSocketTransport.connectTo` and `new monaco.lsp.MonacoLspClient(transport)`; the client syncs every model itself and has no dispose and no options. Since 0.56 `monaco-editor/editor` plus `features/*/register` is a tree shakeable entry; the IDE imports the full `monaco-editor`, hence `chunkSizeWarningLimit: 6000`. Source: `monaco-editor/CHANGELOG.md`, `monaco-editor/esm/external/monaco-lsp-client/out/index.d.ts`, `packages/ide/src/client/monaco.ts`.

`MonacoLspClient` sends `initialize` with `rootUri: null` and no workspace folders. `withWorkspace` in `server.ts` rewrites that first message to inject the workspace folder; without it, references to unopened files do not resolve. Every `/lsp` socket gets its own Langium server. Source: `packages/ide/src/server/server.ts`, commit 5e6989f.

`getWorker` always returns the plain editor worker; only `appling` models exist, so the TS, JSON, CSS and HTML workers are not wired. Monarch highlighting comes from `@appling/lang/monarch`, generated from the grammar, so the client build fails until `@appling/lang` is built. Source: `monaco.ts`, `packages/lang/langium-config.json`.

## Snapshot, dirty models and saves

The graph, inspector and selection read only the snapshot, which is built from disk. Unsaved Monaco text never reaches them; an edit shows after App saves and the watcher pushes a new snapshot (100ms debounce). `/api/edit` receives `modelTexts()`, unsaved text included, and App then saves the whole model text, so an inspector edit also saves unrelated unsaved typing in that file. Source: `App.tsx`, `monaco.ts`, `server.ts`.

A snapshot replaces a model with `setValue` only when the model is clean. Cursor events with `source === 'api'` are ignored so a programmatic reveal does not feed selection back. Source: `Editor.tsx`.

## The model tree

`growTree` (`packages/viz/src/views.ts`) rebuilds the whole tree from the graph and the `unfolded` id set on every change; nothing else holds tree state. Only `ViewSettings` (`lens`, `linkEntities`) persist, through `/api/view` in `.appling/view.json`, merged over `DEFAULT_VIEW` on load; the unfolded set and the camera do not. Node ids are paths: the seed `~`, a module `~/<module>`, a group `<parent>/#<Kind>`, an element `<parent>/<qn>`. The same declaration can therefore appear on several branches with different ids; `cycle` marks one already on its own path. Folding deletes the node's id and every id under it. Source: `views.ts`, `canvas/ModelCanvas.tsx`.

Children come from `relations(index, qn, 'usedBy')`, lifted to top level declarations, minus modules, minus link entities unless `linkEntities` is on. They are sorted by `index.relevanceOf` before grouping, so group order follows each group's most relevant member. `layoutTree` (`layout.ts`) only places: the parent centered below its children, rows centered by `centered()` (first in the middle, then alternating), more than `WRAP` folded children wrapped into rows. Circle radii and the hit rectangle live in the canvas (`RADIUS`, `LABEL`), not in the layout, so a wider label needs `SLOT` in `layout.ts` too. Source: `layout.ts`, `ModelCanvas.tsx`.

## Pan, zoom and clicks

React registers `wheel` as passive, so the canvas adds its own non passive listener to stop page scroll. A drag starts on pointer down and counts as a pan only after 4px; pointer up clears the drag ref in a `setTimeout`, after the click handler had the chance to read `moved`, so a pan never unfolds a node. Branches animate through the CSS `d` property (`style={{ d: 'path(...)' }}`), which Chromium supports and Firefox ignores without breaking. `follow` frames a node and its new children after the layout placed them, zooming out only when they do not fit. Source: `ModelCanvas.tsx`, `canvas.css`.

## Relevance

`GraphIndex` computes `relevance(graph)` once from `@appling/model/relevance` (the subpath keeps langium out of the browser bundle) and `relevanceOf(qn)` lifts members to their declaration. The canvas maps the score to the radius per node type and `relevanceLevel(score)` to the `core`/`supporting`/`peripheral` class for emphasis. Source: `packages/model/src/relevance.ts`, `views.ts`, `ModelCanvas.tsx`.

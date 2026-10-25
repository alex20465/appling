---
name: ide-client
description: How the Appling IDE client works with Monaco 0.57 (native LSP client), React Flow 12 and ELK, and how edits, snapshots and selection flow between client and server. Use when changing the editor, the entity view, the search, the inspector, the /lsp websocket, or when debugging stale graph state, lost selection or LSP features that fail across files.
metadata:
  anchors:
    - name: monaco-editor
      version: 0.57.0
      researched: 2026-10-23
    - name: "@xyflow/react"
      version: 12.12.0
      researched: 2026-10-23
    - name: elkjs
      version: 0.12.0
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

## React Flow 12 (from reactflow 11)

`ReactFlow` is a named import from `@xyflow/react`, CSS is `@xyflow/react/dist/style.css`, subflows use `parentId` (was `parentNode`) with child positions relative to the parent, `width`/`height` are inputs and measured sizes live in `node.measured`, and `onBeforeDelete` can cancel a delete by returning false. Source: https://reactflow.dev/learn/troubleshooting/migrate-to-v12

In the IDE, nodes and edges are derived from the snapshot through `entityView()` and ELK, recomputed as a plain `useMemo` (no `useNodesState`, the canvas is read only: `nodesDraggable` and `nodesConnectable` off, `deleteKeyCode={null}`). Entity highlight comes from `data.selected` (the app's qualified name selection mapped to the shown entity or module by `shownFor`), not React Flow's `selected`. Source: `packages/viz/src/canvas/EntityCanvas.tsx`.

## Layout

ELK child coordinates under `hierarchyHandling: INCLUDE_CHILDREN` are relative to the enclosing module, matching React Flow `parentId`. Module group nodes are emitted before entities so a parent precedes its children; a module without entities needs an explicit width and height or ELK gives it zero size. Positions are not persisted; only the view options (`ViewSettings`, `/api/view`, `.appling/view.json`), merged over `DEFAULT_VIEW` on load. Source: `packages/viz/src/layout.ts`, https://reactflow.dev/learn/layouting/sub-flows

elkjs 0.12 has no `exports` map; `elkjs/lib/elk.bundled.js` without `workerUrl` runs layout on the main thread. A worker needs `workerUrl` or `workerFactory` with `elk-api.js`. Source: `elkjs/README.md`, `packages/viz/src/layout.ts`. Under NodeNext the default import is the CommonJS module object, so `layout.ts` constructs `Elk.default`, which the bundle also sets.

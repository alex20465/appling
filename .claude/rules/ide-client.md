---
paths:
  - packages/ide/src/client/**
  - packages/ide/src/server/server.ts
  - packages/ide/src/shared/snapshot.ts
  - packages/ide/vite.config.ts
  - packages/ide/test/model.test.ts
---

# IDE client

- Do not add `monaco-languageclient`, `vscode-languageclient` or `@codingame` packages; Monaco 0.57 ships its own LSP client as `monaco.lsp`.
- Import Monaco files through its `exports` map (`monaco-editor/editor/...`), never the old `monaco-editor/esm/vs/...` deep path.
- Do not add a Vite dev server, proxy or HMR setup; the IDE server serves the built client and rejects any other Host or Origin.
- Never let React Flow change the model locally: deletes and connects go through edit ops, drags persist only to `.appling/layout.json`.
- Keep `nodeTypes` at module scope; defining it in a component remounts every node.
- Keep `graph/model.ts` free of React, `@xyflow`, Monaco and DOM imports; vitest imports it in Node.
- Keep the `levelForZoom` thresholds and `ZOOM_RANGE` in step, so `fitView` never switches the level.
- Before changing these files, use the `ide-client` skill.

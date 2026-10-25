---
paths:
  - packages/ide/src/client/**
  - packages/ide/src/server/server.ts
  - packages/ide/src/shared/snapshot.ts
  - packages/ide/vite.config.ts
  - packages/viz/**
---

# IDE client

- Do not add `monaco-languageclient`, `vscode-languageclient` or `@codingame` packages; Monaco 0.57 ships its own LSP client as `monaco.lsp`.
- Import Monaco files through its `exports` map (`monaco-editor/editor/...`), never the old `monaco-editor/esm/vs/...` deep path.
- Do not add a Vite dev server, proxy or HMR setup; the IDE server serves the built client and rejects any other Host or Origin.
- Keep the canvas read only: no drags, connects or deletes; the model changes only through edit ops from the inspector and AI proposals.
- Keep `nodeTypes` at module scope; defining it in a component remounts every node.
- Keep `packages/viz/src/views.ts` free of React, `@xyflow`, Monaco and DOM imports; vitest imports it in Node.
- Draw only modules and entities on the IDE canvas; every other element is reached through search and the inspector. The card views belong to the visualization window.
- Before changing these files, use the `ide-client` skill.

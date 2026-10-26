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
- Do not bring back React Flow, ELK or another graph library; the model canvas is own SVG.
- Keep `packages/viz/src/views.ts` free of React, Monaco and DOM imports, and import from `@appling/model` only through its browser safe subpaths (`/simulator`, `/relevance`); vitest imports it in Node.
- The canvas draws one lens at a time (`LENSES` in `views.ts`) as a tree that shows only what is unfolded: seed, modules, the lens's declarations, then what uses each unfolded declaration. Never draw the whole model at once. Members are reached through search and the inspector. The card views belong to the visualization window.
- Relevance (`relevance` in `@appling/model`) decides circle size, order within a row and emphasis; do not compute importance anywhere else.
- Before changing these files, use the `ide-client` skill.

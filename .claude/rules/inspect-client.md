---
paths:
  - packages/inspect/src/client/**
  - packages/inspect/src/server/server.ts
  - packages/inspect/src/shared/snapshot.ts
  - packages/inspect/vite.config.ts
  - packages/viz/**
---

# Inspector client

- Keep the inspector read only: no editor, no edit operations, no file writes besides `.appling/view.json`, no generation. The text is edited elsewhere (the user's editor, an agent).
- Do not add a Vite dev server, proxy or HMR setup; the inspector server serves the built client and rejects any other Host or Origin.
- Keep the canvas read only: no drags, connects, deletes or node menus.
- Do not bring back React Flow, ELK or another graph library; the model canvas is own SVG.
- Keep `packages/viz/src/views.ts` free of React and DOM imports, and import from `@appling/model` only through its browser safe subpaths (`/simulator`, `/relevance`); vitest imports it in Node.
- The canvas draws one lens at a time (`LENSES` in `views.ts`) as a tree that shows only what is unfolded: seed, modules, the lens's declarations, then what uses each unfolded declaration. Never draw the whole model at once. Members are reached through the inspector. The card views are for agent views (`AgentView.tsx`).
- Relevance (`relevance` in `@appling/model`) decides circle size, order within a row and emphasis; do not compute importance anywhere else.
- Before changing these files, use the `inspect-client` skill.

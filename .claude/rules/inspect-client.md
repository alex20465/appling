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
- The canvas draws one pyramid of five level bands (`LENSES` in `views.ts`, L1 domain to L5 access, L5 on top) from one entry level (`ViewSettings.lens`) and shows only what is unfolded: the modules as frames around their declarations of the entry level, then per declaration what rests on it on higher levels (upwards) and what it rests on on lower levels (downwards). Never draw the whole model at once. Every declaration stands in the band of its own level; never draw one outside it or a second time: join to the drawn one (`links`). Relations inside one level do not unfold. Members are reached through the inspector. The card views are for agent views (`AgentView.tsx`).
- Relevance (`relevance` in `@appling/model`) decides the order within a kind and the emphasis; do not compute importance anywhere else.
- Before changing these files, use the `inspect-client` skill.

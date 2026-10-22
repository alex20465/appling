---
paths:
  - packages/lang/src/**
  - packages/lang/test/**
  - packages/model/src/edit.ts
  - packages/model/src/graph.ts
---

# Langium language

- Use `Expr.$type` and the generated property constants, never a bare type name string as in Langium 3.
- Import `createConnection` and `ProposedFeatures` from `vscode-languageserver/node`; keep the range at `~10.1.0`, the one Langium itself depends on.
- Never mutate the CST; change text and reparse, as `edit.ts` does.
- Keep the terminal names `WS`, `SL_COMMENT` and `ML_COMMENT`; the printer matches them by name.
- Put layout into `BLOCKS` and `CLAUSES` in `appling-printer.ts`, never into formatter rules.
- Call `ConfigurationProvider.initialized({})` when creating LSP services without a connection, or configuration reads hang.
- Do not treat the LSP rename as complete; only `applyEdit` with `op: 'rename'` follows string names.
- Before changing these files, use the `langium-language` skill.

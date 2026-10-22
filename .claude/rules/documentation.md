---
paths:
  - packages/{lang,model,cli,ide,ai,codegen,codegen-django,codegen-ash,vscode}/src/**
  - packages/{lang,model,cli,ide,ai,codegen,codegen-django,codegen-ash,vscode}/package.json
  - packages/*/README.md
  - packages/ai/skills/**
  - examples/**
  - docs/**
  - packages/landing/src/{docs.ts,markdown.ts,content.config.ts}
  - packages/landing/src/pages/docs/**
---

# Documentation

- Update the docs in `docs/` in the same change as any behavior a user can see: commands, flags, output, exit codes, keywords, validation rules, graph shape, edit operations, configuration, generated code, MCP tools, IDE features, public exports.
- After changing the grammar, `appling-scope.ts` or `appling-validator.ts`, update the matching `docs/language/*.md` page and `docs/language/validation.md`.
- After changing `appling-types.ts`, update `docs/language/expressions.md` and `docs/language/validation.md`.
- After changing `packages/lang/src/{lsp,language-server}.ts` or `packages/vscode/**`, update `docs/tools/editors.md`.
- After changing `packages/model/src/graph.ts`, update `docs/reference/graph.md`.
- After changing `packages/model/src/edit.ts`, update `docs/reference/edit-operations.md` and `docs/tools/ide.md`.
- After changing `packages/model/src/release.ts`, update `docs/language/migrations.md` and `docs/tools/cli.md`.
- After changing `packages/cli/src/**`, update `docs/tools/cli.md` and the commands quoted in `docs/getting-started/*.md`.
- After changing `packages/ide/src/**`, update `docs/tools/ide.md`.
- After changing `packages/ai/**`, update `docs/tools/ai.md` and `docs/reference/configuration.md`.
- After changing `packages/codegen/src/**`, update `docs/codegen/{overview,registry,migrations,extensions}.md` and `docs/reference/configuration.md`.
- After changing `packages/codegen-django/src/**`, update `docs/codegen/django.md`; after `packages/codegen-ash/src/**`, `docs/codegen/ash.md`.
- After changing the exports of any `src/index.ts`, update `docs/reference/api.md`.
- Give a new user facing feature that no page covers its own page.
- After renaming or removing anything, search `docs/` for the old name and fix every hit.
- Keep the package `README.md` and the docs page on the same topic consistent; the code wins over both.
- After finishing a roadmap item, tick it in `docs/ROADMAP.md` and update `packages/landing/src/components/Roadmap.astro`.
- Before writing or changing a docs page, use the `documentation` skill.

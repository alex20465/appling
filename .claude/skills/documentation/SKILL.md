---
name: documentation
description: How the Appling user documentation in docs/ is written and published on the landing site at /docs. Page format and frontmatter, the sidebar in packages/landing/src/docs.ts, validated `appling check` and `appling graph` examples, mermaid diagrams, GitHub alerts, link rewriting, writing style and how to verify a change. Use when writing, updating, moving, renaming or reviewing a docs page, when a code change needs its docs updated, or when changing the docs rendering in the landing package.
---

# Documentation

`docs/` at the repo root is the single documentation source. It reads as plain Markdown on GitHub and the landing site renders it at `https://appling.tools/docs/<id>/`, where the id is the path under `docs/` without `.md`, lowercased (`docs/ROADMAP.md` is `/docs/roadmap/`, `docs/index.md` is `/docs/`).

## Rendering pipeline

| File | Does |
|---|---|
| `packages/landing/src/content.config.ts` | Loads `../../docs/**/*.md` as the `docs` collection; frontmatter schema `title`, `description` |
| `packages/landing/src/docs.ts` | `SECTIONS`: the sidebar, in reading order. The build fails when a page is missing from it or listed but absent |
| `packages/landing/src/markdown.ts` | `remarkDocs` (examples, mermaid, links), the Shiki grammar built from `@appling/lang/monarch` keywords, the code theme |
| `packages/landing/src/pages/docs/[...slug].astro` | Page layout: sidebar, title, table of contents from `##`/`###`, previous and next, edit on GitHub, mermaid loader |
| `packages/landing/src/styles/global.css` | `.docs-prose` (typography plugin colors), `.markdown-alert-*`, `.model-graph` |

The landing imports `@appling/lang` and `@appling/model` from their `out/` builds; build them before the site.

## Page format

```markdown
---
title: Domain layer
description: One sentence; the meta description and the subtitle under the title.
---

Intro paragraph. No `# h1`: the site prints the title.

## Section
```

- Wrap a `title` or `description` that contains `: ` in double quotes, or the YAML fails to parse and the build stops.
- Link other pages by relative path to the `.md` file (`../tools/cli.md#generate`); `remarkDocs` rewrites them to `/docs/...`. Relative links to other repo files become GitHub links.
- A new page needs an entry in `SECTIONS` and a `<url>` in `packages/landing/public/sitemap.xml`.
- Moving or renaming a page changes its URL: update `SECTIONS`, the sitemap, every link to it (`grep -rn 'old-name.md' docs`), and remember the deploy keeps the old URL live (see the `landing-site` skill).

## Markdown features

- ```` ```appling ```` highlights only; use it for fragments.
- ```` ```appling check ```` must be a complete model (`module { }` blocks). The site build validates it and fails with the error and line.
- ```` ```appling graph ```` validates and draws the semantic graph below the code: declarations by layer color, member references folded into their declaration, one arrow per pair labeled with the reference kinds. Keep it under about 10 declarations.
- ```` ```mermaid ```` renders in the browser with the site theme. Do not add `classDef` or `%%{init}` styling. Never use a Mermaid keyword (`graph`, `end`, `subgraph`, `style`, `class`) as a node id; the diagram fails with a syntax error only in the browser, the build does not catch it.
- GitHub alerts: `> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`, `> [!CAUTION]`.

## Writing style

- No dashes between words or clauses and no hyphenated compounds in prose ("cross cutting", "built in", "read only"); hyphens only inside code, paths and flags. No emoji.
- Short sentences, present tense, "you" in guides. Tables for mappings and options, one runnable example per concept.
- Facts only from the code: read the source before describing a flag, keyword, option or output. Paste real output from the built CLI, trimmed.

## Updating docs after a code change

1. Find the pages: the `documentation` rule maps source paths to pages; also `grep -rln '<keyword or flag>' docs packages/*/README.md`.
2. Change the text, tables and examples. Update the package README on the same topic.
3. Validate every changed `check`/`graph` example: save it to a scratch file, `node packages/cli/out/main.js check <file>` must report 0 errors and `fmt` must not change it (examples are in canonical form).
4. Build: `pnpm --filter @appling/landing... build` builds lang, model and the site; it fails on an invalid example or a sidebar mismatch.

## Verifying the rendered site

Run `pnpm --filter @appling/landing build` and read `packages/landing/dist/docs/<id>/index.html`, or ask the user to start `astro preview` and look at mermaid diagrams and graphs in the browser; they render client side, so the HTML holds only their source.

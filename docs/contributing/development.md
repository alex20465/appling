---
title: Development setup
description: Build, test and run the Appling monorepo locally.
---

Appling is a pnpm workspace of TypeScript packages under `packages/`. This page gets you from a fresh clone to a passing test run.

## Requirements

- Node.js 24 (the version is in `.nvmrc`).
- pnpm through corepack. The version is pinned in `package.json` (`packageManager`); run `corepack enable` once so `pnpm` uses it. An older global pnpm cannot install this workspace.
- For end to end code generation runs only: `uv` (Django) and Elixir with `igniter_new` (Ash). The tests do not need them.

## Build and test

```sh
pnpm install
pnpm build            # every package in dependency order
pnpm test             # vitest over packages/*/test
pnpm check examples   # validates the sample models with the built CLI
pnpm fmt examples     # canonical formatting
```

`pnpm build` runs `langium generate` and `tsc` in `@appling/lang` (the generated parser goes to `packages/lang/src/generated/`, which is not committed), `tsc` in the other packages, Vite for the IDE client and Astro for the landing site.

`check` and `fmt` run the built CLI (`packages/cli/out/main.js`), so rebuild after a source change.

## Working on one package

```sh
pnpm --filter @appling/lang build                                   # after a grammar change
pnpm vitest run packages/lang/test/validation.test.ts -t "name"     # one file, one test
pnpm vitest run -u                                                  # update snapshots
node packages/cli/out/main.js graph examples                        # the semantic graph as JSON
node packages/ide/out/server/main.js examples                       # the IDE on http://127.0.0.1:4410
```

The language tests import `src/` directly and only need `langium generate`. Every other package's tests import `@appling/*` through the packages' `out/` exports, so rebuild an upstream package before testing a downstream one.

## Conventions

- Every validation rule has a negative fixture in `packages/lang/test/validation.test.ts`. Add one with each new rule.
- `fmt` must be idempotent: a second run changes nothing.
- `examples/sales.appling` and `examples/crm.appling` reference each other across modules. Use them to check changes against a realistic model.
- New dependencies: the workspace enforces a minimum release age. A dependency published very recently needs an entry under `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`.
- Every package has a user facing `README.md` published to npm, and this documentation covers the same ground in depth. Change both with the code; see [documentation](documentation.md).
- Commits follow Conventional Commits, such as `feat(codegen-django): ...`.

## Where to start reading

[Architecture](architecture.md) explains how the packages fit together and the mechanics that span several of them. The [design concept](../concept.md) is the authority when a grammar or validation decision is unclear.

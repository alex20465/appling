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
node packages/desktop/out/bin.js examples                           # Appling Desktop on the sample models
```

The language tests import `src/` directly and only need `langium generate`. Every other package's tests import `@appling/*` through the packages' `out/` exports, so rebuild an upstream package before testing a downstream one.

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request and every push to `main`. Each step is a plain command, so you can run it the same way locally:

| Job | Runs |
|---|---|
| Build and test | `pnpm install --frozen-lockfile`, `pnpm build` (the landing site validates the docs examples), `pnpm test`, `node packages/cli/out/main.js check examples`, then `fmt examples` followed by `git diff --exit-code` |
| Codegen coverage | `node scripts/ci/codegen-coverage.mjs` on the pull request and on its base, written to the job summary |
| Coverage comment | Posts the report as one comment on the pull request and updates it on every push. Pull requests from forks get no write token, so they only get the job summary |
| Coverage badge | On `main` only: pushes the badge JSON to the `badges` branch, which the README shows through shields.io |

No test starts Electron, and pnpm does not run Electron's download script, so the runner never fetches the Electron binary. `packages/desktop/test/remote-integration.test.ts` runs against a real sshd and a docker container and skips each one without it. The Ubuntu runner has docker, and the job installs `openssh-server` when sshd is missing, so CI runs both remote transports.

### Codegen coverage report

```sh
pnpm --filter "@appling/codegen-*..." build
node scripts/ci/codegen-coverage.mjs                      # Markdown on stdout
node scripts/ci/codegen-coverage.mjs --json coverage.json --markdown coverage.md --badge badge.json
node scripts/ci/codegen-coverage.mjs --root ../appling-main --json base.json --markdown /dev/null
node scripts/ci/codegen-coverage.mjs --base base.json     # with the change against base.json
```

The script plans every extension in `packages/codegen-*` over two inputs: the fixture that uses every construct (`packages/lang/test/fixtures/constructs`, the one the `coverage.test.ts` files use) and `examples/`. Per extension it reports the share of elements that are `generated`, `partial` and `todo`, the completion and the registry tasks, then each figure per element kind. `--root` plans another checkout (its language, fixture, examples and extensions) with this script; CI measures the base branch that way.

The headline figure, and the badge, is the completion over every extension and both inputs:

```
completion = (generated + partial / 2) / (generated + partial + todo)
```

A `partial` element has code and open registry tasks, so it counts as half. With `--base`, each figure shows its change: `▲` for a gain, `▼` for a drop, in percentage points for shares. Fewer registry tasks is a gain, so `▲ -2` means two tasks fewer. `appling generate --coverage` prints the same report for the targets of a project (see [the CLI](../tools/cli.md#coverage)).

## Conventions

- Every validation rule has a negative fixture in `packages/lang/test/validation.test.ts`. Add one with each new rule.
- `fmt` must be idempotent: a second run changes nothing.
- `examples/sales.appling` and `examples/crm.appling` reference each other across modules. Use them to check changes against a realistic model.
- New dependencies: the workspace enforces a minimum release age. A dependency published very recently needs an entry under `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`.
- Every package has a user facing `README.md` published to npm, and this documentation covers the same ground in depth. Change both with the code; see [documentation](documentation.md).
- Commits follow Conventional Commits, such as `feat(codegen-django): ...`.

## Where to start reading

[Architecture](architecture.md) explains how the packages fit together and the mechanics that span several of them. The [design concept](../concept.md) is the authority when a grammar or validation decision is unclear.

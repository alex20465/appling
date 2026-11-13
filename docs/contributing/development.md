---
title: Development setup
description: Build, test and run the Appling monorepo locally.
---

Appling is a pnpm workspace of TypeScript packages under `packages/`. This page gets you from a fresh clone to a passing test run.

## Requirements

- Node.js 24 (the version is in `.nvmrc`).
- pnpm through corepack. The version is pinned in `package.json` (`packageManager`); run `corepack enable` once so `pnpm` uses it. An older global pnpm cannot install this workspace.
- For end to end code generation runs only: `uv` (Django), Elixir with `igniter_new` (Ash), Go or Rust, or Docker instead of all four (see [generated projects end to end](#generated-projects-end-to-end)). The tests do not need them.

## Build and test

```sh
pnpm install
pnpm build            # every package in dependency order
pnpm test             # vitest over packages/*/test
pnpm check examples   # validates the sample models with the built CLI
pnpm fmt examples     # canonical formatting
```

`pnpm build` runs `langium generate` and `tsc` in `@appling/lang` (the generated parser goes to `packages/lang/src/generated/`, which is not committed), `tsc` in the other packages, Vite for the inspector client and Astro for the landing site.

`check` and `fmt` run the built CLI (`packages/cli/out/main.js`), so rebuild after a source change.

## Working on one package

```sh
pnpm --filter @appling/lang build                                   # after a grammar change
pnpm vitest run packages/lang/test/validation.test.ts -t "name"     # one file, one test
pnpm vitest run -u                                                  # update snapshots
node packages/cli/out/main.js graph examples                        # the semantic graph as JSON
```

The language tests import `src/` directly and only need `langium generate`. Every other package's tests import `@appling/*` through the packages' `out/` exports, so rebuild an upstream package before testing a downstream one.

## Make shortcuts

The `Makefile` at the root turns every script of the repo into a target. It reads them on each run, so a new script needs no edit there:

```sh
make                                         # lists every target
make build                                   # a script of the root package.json
make packages/vscode/host:link               # a script of a package's package.json
make scripts/ci/codegen-e2e ARGS=django      # a .mjs or .sh file under scripts/, without the extension
make check ARGS=examples                     # ARGS goes to the script
make link/cli                                # a package's commands into ~/.local/bin (BIN_DIR=... for another folder)
make unlink/cli                              # removes them again
```

`make link/<package>` exists for every package with a `bin` or a `host:link` script. Each command becomes a small launcher that runs the built file in the repo, so a rebuild takes effect at once; build the package first. The VS Code extension (`make link/vscode`) runs its `host:link` instead. A command that already exists and was not linked this way stays untouched.

For Tab completion, source `scripts/make-completion.bash` from `~/.bashrc`. It completes the targets with their colons, which the make completion of bash-completion cuts off, and hands over to that completion outside the repo:

```sh
source ~/Dev/appling/scripts/make-completion.bash
```

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request and every push to `main`. Each step is a plain command, so you can run it the same way locally:

| Job | Runs |
|---|---|
| Build and test | `pnpm install --frozen-lockfile`, `pnpm build` (the landing site validates the docs examples), `pnpm test`, `node packages/cli/out/main.js check examples`, then `fmt examples` followed by `git diff --exit-code` |
| Codegen coverage | `node scripts/ci/codegen-coverage.mjs` on the pull request and on its base, written to the job summary |
| Coverage comment | Posts the report as one comment on the pull request and updates it on every push. Pull requests from forks get no write token, so they only get the job summary |
| Coverage badge | On `main` only: pushes the badge JSON to the `badges` branch, which the README shows through shields.io |

The `VS Code extension` workflow (`.github/workflows/vscode.yml`) runs `pnpm --filter appling-vscode... build` on pull requests and pushes to `main` that touch `packages/` (except `landing`) or the lockfile, and on demand. It uploads `packages/vscode/out/appling.vsix` as an artifact, which installs on every platform.

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

A `partial` element has code and open registry tasks, so it counts as half. Only generator gaps count: a task an extension marks `leftToCode` (work the model leaves to the code by design, [design concept, section 8](../concept.md#8-what-belongs-in-the-model)) is reported in its own column and does not lower the completion; an element whose only open tasks are left to code counts as generated. With `--base`, each figure shows its change: `▲` for a gain, `▼` for a drop, in percentage points for shares. Fewer registry tasks is a gain, so `▲ -2` means two tasks fewer. `appling generate --coverage` prints the same report for the targets of a project (see [the CLI](../tools/cli.md#coverage)).

## Generated projects end to end

The codegen tests apply the steps in memory and compare snapshots; they never run a framework command or a compiler. `scripts/ci/codegen-e2e.mjs` does: for one target it generates `examples/` and the all constructs fixture (`packages/lang/test/fixtures/constructs/`), each in its own workspace with an `appling.config.json` for that target, and then builds and tests the result with the real toolchain.

```sh
pnpm build
node scripts/ci/codegen-e2e.mjs go                         # both models, in a new temp folder
node scripts/ci/codegen-e2e.mjs django examples --out /tmp/e2e
scripts/ci/codegen-e2e-docker.sh rust                      # the same inside the official image
```

| Target | Toolchain | After `appling generate` |
|---|---|---|
| `django` | `uv`, Python 3.12 | `manage.py check`, `makemigrations --check --dry-run`, `migrate`, `manage.py test` |
| `ash` | Elixir 1.18 on OTP 28, Postgres on `localhost` (user and password `postgres`) | `mix compile --warnings-as-errors`, `mix test` (`MIX_ENV=test`) |
| `go` | Go 1.25 | `go build ./...`, `go vet ./...`, `go test ./...` |
| `rust` | stable Rust | `cargo check --all-targets`, `cargo test`, both with `RUSTFLAGS="-D warnings"` |

Every key in the generated `.env.example` gets the placeholder `0`, the way a developer fills `.env`. When the model has secrets, the Django and Ash runs then check that the app stops without them and names the missing variable (`manage.py check`, `mix run --no-start`). Skipped tests (the registry task skeletons) pass; a failing test, a compiler error or a warning fails the run. For Ash the script first installs the `igniter_new` and `phx_new` archives. Without a local toolchain, `scripts/ci/codegen-e2e-docker.sh <target>` runs the script in `ghcr.io/astral-sh/uv:python3.12-bookworm-slim`, `elixir:1.18`, `golang:1.25` or `rust:1` with your Node mounted in (for Ash next to a `postgres:16-alpine` container); the projects stay in `.e2e/<target>/` and the caches in `.e2e/home/`, both ignored by git. Igniter and Phoenix compile a lot of dependencies: give Docker at least 6 GB of memory for Ash.

On GitHub the `Codegen end to end` workflow (`.github/workflows/codegen-e2e.yml`) runs the script once per target on pull requests that touch the codegen packages, `lang`, `model`, `cli`, `examples/` or the script, every night and on demand. A failing job uploads the generated projects as an artifact. When a generated project does not build, fix the generator in its extension and add a snapshot or unit test for the fix.

## UI sandbox

`pnpm sandbox <target>` starts the inspector in a sandbox an AI agent can see and use: it copies `examples/` into `.sandbox/workspace` (a git repo with one commit) and opens it with Chrome DevTools listening on `127.0.0.1:9222`. The `sandbox` MCP server in `.mcp.json` (Playwright MCP) connects there, and the `ui-sandbox` skill tells the agent how to walk the UI, take screenshots and fix what is plainly broken.

| Target | Opens |
|---|---|
| `inspect` | the inspector server at `127.0.0.1:4410` in a Chrome app window |
| `openvscode` | openvscode-server at `127.0.0.1:4411` with the built `appling.vsix`, in a Chrome app window |
| `vscode` | VS Code with its own profile and the extension from `packages/vscode` |

Build the targets first (`pnpm build`). Every target keeps its profile under `.sandbox/<target>`, apart from your own editors and app data; the workspace starts fresh on every start. One target runs at a time, since they share the DevTools port.

## Language size

The language stays small enough for an assistant to read all of it ([design concept, section 8](../concept.md#8-what-belongs-in-the-model)). Two checks hold it there:

- `packages/ai/test/language-budget.test.ts` fails when `docs/language/`, the reference the MCP tool `language_reference` serves, grows past 100,000 characters (about 25k tokens). A new construct fits into that budget or replaces something.
- `scripts/bench/ai-modeling.mjs` gives each business brief in `scripts/bench/briefs/` to a fresh `claude -p` session that knows only that reference and has no tools, checks the model it answers with the built CLI and prints its errors, the element kinds it uses and its length. Run it before and after a language change; it needs Claude Code and spends tokens, so CI does not run it.

```sh
node scripts/bench/ai-modeling.mjs                      # every brief once with sonnet
node scripts/bench/ai-modeling.mjs --model haiku --runs 3 --brief clinic --keep
```

```
reference: 13 pages, 89189 characters (about 22297 tokens); model sonnet

| brief | run | errors | kinds | lines |
|---|---|---|---|---|
| clinic | 1 | 0 | 23 | 179 |
| expenses | 1 | 0 | 29 | 219 |
| library | 1 | 0 | 22 | 188 |

3 of 3 runs wrote a valid model.
```

## Conventions

- Every validation rule has a negative fixture in `packages/lang/test/validation.test.ts`. Add one with each new rule.
- `fmt` must be idempotent: a second run changes nothing.
- `examples/sales.appling` and `examples/crm.appling` reference each other across modules. Use them to check changes against a realistic model.
- New dependencies: the workspace enforces a minimum release age. A dependency published very recently needs an entry under `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`.
- Every package has a user facing `README.md` published to npm, and this documentation covers the same ground in depth. Change both with the code; see [documentation](documentation.md).
- Commits follow Conventional Commits, such as `feat(codegen-django): ...`.

## Where to start reading

[Architecture](architecture.md) explains how the packages fit together and the mechanics that span several of them. The [design concept](../concept.md) is the authority when a grammar or validation decision is unclear.

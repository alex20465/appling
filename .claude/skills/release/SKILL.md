---
name: release
description: Release the public @appling/* npm packages with pnpm 12's built in release management. Collects the changes per package since its last release from the git log, records change intents in .changeset/, bumps versions with `pnpm version -r` (independent versions, dependents follow), writes the committed CHANGELOG.md files, commits, pushes and publishes with `pnpm publish -r`. Use when the user asks to release, publish, bump versions, cut a version, ship to npm or update the changelogs.
metadata:
  anchors:
    - name: pnpm
      version: 12.14.0
      researched: 2026-10-23
---

# Release

Versions are independent per package. `versioning.changelog.storage: repository` in `pnpm-workspace.yaml` keeps one committed `CHANGELOG.md` per package. Intents use the changesets format in `.changeset/`; `pnpm version -r` consumes them and appends to `.changeset/ledger.yaml`. Source: https://pnpm.io/versioning, https://pnpm.io/cli/change, https://pnpm.io/cli/version, https://pnpm.io/cli/publish

Always run pnpm as `corepack pnpm`.

## 1. Preflight

Stop and report when one fails:

- `git branch --show-current` is `main`, `git status --porcelain` is empty (`pnpm version -r` and `pnpm publish` refuse a dirty tree), `git fetch && git status -sb` is not behind.
- `npm whoami` answers. On `E401`, ask the user to run `! npm login`.

- `corepack pnpm audit` reports no high or critical advisory for any package. On a finding, name the affected packages and ask how to fix it (overrides in `pnpm-workspace.yaml`, or bump the direct dependency), re-audit, build and test, and commit the fix before continuing.

## 2. Collect changes

For every package in `packages/*` without `"private": true`:

1. Published version: `npm view <name> version` (`E404` means first release).
2. Baseline: `git log -1 --format=%H -G'"version"' -- packages/<dir>/package.json`.
3. Changes: `git log --format='%h %s' <baseline>..HEAD -- packages/<dir>/src packages/<dir>/README.md packages/<dir>/package.json`, plus every other path in its `files` that is not `out` or `dist` (`packages/ai/skills`).

A package on its first release debuts at its manifest version exactly; intents for it apply from the next release, so it needs none. A package whose manifest version is already ahead of the registry gets published as is.

Pick the bump from the commit types:

| Commits | `< 1.0.0` | `>= 1.0.0` |
|---|---|---|
| `!` or `BREAKING CHANGE` | minor | major |
| `feat` | patch | minor |
| `fix`, `perf`, `refactor` touching src | patch | patch |
| only `docs`, `test`, `chore`, `style` | no intent | no intent |

Dependents through `workspace:` ranges are bumped by pnpm itself; do not add intents for them.

## 3. Confirm the plan

Show the user one table per package: published version, bump, and the changelog lines. Ask with AskUserQuestion to approve or adjust. Write nothing before the answer.

## 4. Record and apply

One intent per user visible change, its summary one sentence for npm users, not the commit subject:

```sh
corepack pnpm change --bump <patch|minor|major> --summary "<sentence>" <name> [<name>...]
corepack pnpm change status
corepack pnpm version -r --dry-run --no-git-checks
```

Compare the dry run with the approved plan, then commit the intents (`chore(release): record change intents`) so the tree is clean, and run:

```sh
corepack pnpm version -r
corepack pnpm build
corepack pnpm test
```

On a failing build or test, stop and report; do not publish.

## 5. Commit, push, publish

1. Commit `package.json`, `CHANGELOG.md`, `.changeset/` with the `commit` skill, subject `chore(release): <name>@<version>, ...`.
2. Ask with AskUserQuestion to confirm push and publish, listing every `name@version`.
3. `git push`, then `corepack pnpm publish -r --access public --report-summary`. pnpm publishes only the versions not yet on the registry and replaces `workspace:*` with the real versions.
4. On an OTP request, ask the user for the code and rerun with `--otp <code>`. Already published packages are skipped on the rerun.

## 6. Verify

Read `pnpm-publish-summary.json`, check each entry with `npm view <name>@<version> version`, then delete the summary file. Report the published versions.

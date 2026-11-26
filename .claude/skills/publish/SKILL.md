---
name: publish
description: Release the public @appling/* npm packages and the VS Code extension (appling-vscode) with pnpm 12's built in release management. Collects the changes per package since its last release from the git log, records change intents in .changeset/, bumps versions with `pnpm version -r` (independent versions, dependents follow), writes the committed CHANGELOG.md files, commits, pushes and publishes with `pnpm publish -r`; the push lets CI publish the extension to the Marketplace and tag it. Use when the user asks to release, publish, bump versions, cut a version, ship to npm or the Marketplace or update the changelogs.
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

For every package in `packages/*` without `"private": true`, plus the private `appling-vscode`:

1. Published version: `npm view <name> version` (`E404` means first release). For `appling-vscode` the newest tag of `git tag -l 'appling-vscode@*' --sort=-v:refname` (none means first release).
2. Baseline: `git log -1 --format=%H -G'"version"' -- packages/<dir>/package.json`.
3. Changes: `git log --format='%h %s' <baseline>..HEAD -- packages/<dir>/src packages/<dir>/README.md packages/<dir>/package.json`, plus every other path in its `files` that is not `out` or `dist` (`packages/ai/skills`). For `appling-vscode`: `-- packages ':!packages/landing'`, since the vsix bundles every package it depends on and pnpm does not bump it for their releases.

A package on its first release debuts at its manifest version exactly; intents for it apply from the next release, so it needs none. A package whose manifest version is already ahead of the registry gets published as is.

Pick the bump from the commit types:

| Commits | `< 1.0.0` | `>= 1.0.0` |
|---|---|---|
| `!` or `BREAKING CHANGE` | minor | major |
| `feat` | patch | minor |
| `fix`, `perf`, `refactor` touching src | patch | patch |
| only `docs`, `test`, `chore`, `style` | no intent | no intent |

Dependents through `workspace:` ranges are bumped by pnpm itself; do not add intents for them. Changes that already have a pending intent (`corepack pnpm change status`, recorded when their task finished) need none.

A version already ahead of the registry takes new intents into itself instead of bumping again, even a minor one; raise it by hand when the intents need a larger bump than it has.

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

### VS Code screenshots

Retake the two screenshots of the landing site's VS Code section (`packages/landing/src/components/VSCode.astro`) from this build with the `ui-sandbox` skill: ask the user to run `pnpm sandbox vscode`, set the window to 1440x900 in the dark theme, and recreate each shot as its `alt` text describes:

- `packages/landing/public/vscode-canvas.webp`: the canvas in a tab, the sales module unfolded up to `sales.Order`, the Inspector panel listing its actions, fields and what uses it.
- `packages/landing/public/vscode-editor.webp`: the canvas on the left, `sales.appling` on the right at `entity Order`, the gutter marks visible.

- `packages/landing/public/inspect-canvas.webp` (Example section, `Example.astro`): from `pnpm sandbox inspect`, the canvas only at 960x480, `sales.Order` unfolded upwards and centred.

A user with VSCodium starts the target with `CODE=codium pnpm sandbox vscode`. Replace the home path in the inspector header with `~/workspace` before a shot. Take them as PNG under `.sandbox/output`, convert to WebP at the same names, look at both, and update the `alt` and `text` in `VSCode.astro` when what they show changed.

## 5. Commit, push, publish

1. Commit `package.json`, `CHANGELOG.md`, `.changeset/` and the screenshots with the `commit` skill, subject `chore(release): <name>@<version>, ...`.
2. Ask with AskUserQuestion to confirm push and publish, listing every `name@version`.
3. `git push`, then `corepack pnpm publish -r --access public --report-summary`. pnpm publishes only the versions not yet on the registry and replaces `workspace:*` with the real versions. It skips the private `appling-vscode`: the push runs the `publish` job of `.github/workflows/vscode.yml`, which publishes a new version to the Marketplace (trusted publishing, environment `marketplace`) and pushes the tag `appling-vscode@<version>`.
4. On an OTP request, ask the user for the code and rerun with `--otp <code>`. Already published packages are skipped on the rerun.

## 6. Verify

Read `pnpm-publish-summary.json`, check each entry with `npm view <name>@<version> version`, then delete the summary file. For a released `appling-vscode`, follow the run with `gh run watch $(gh run list --workflow vscode.yml --branch main --limit 1 --json databaseId --jq '.[0].databaseId') --exit-status` and check `git ls-remote --tags origin 'appling-vscode@<version>'`. Report the published versions.

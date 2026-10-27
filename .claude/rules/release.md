---
paths:
  - packages/*/package.json
  - packages/*/CHANGELOG.md
  - .changeset/**
  - pnpm-workspace.yaml
---

# Release

- Never change a package's `version` field by hand; versions change only through `corepack pnpm version -r`.
- Never edit `CHANGELOG.md` files or `.changeset/ledger.yaml`; pnpm writes them.
- Never record change intents outside a release; they are written at release time from the git log.
- Never publish to npm or push a release commit without the user's confirmation in this conversation.
- Before bumping versions or publishing, use the `release` skill.
- After adding or changing an entry under `overrides` in `pnpm-workspace.yaml` or a dependency of `@appling/landing`, run `corepack pnpm --filter @appling/landing exec bunny-transfer --help`. The deploy tools run only in CI, so a broken one stays unseen until the push to `main` fails.

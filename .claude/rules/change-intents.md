---
paths:
  - packages/*/src/**
  - packages/*/README.md
  - packages/ai/skills/**
---

# Change intents

- When a task changes what users of a published `@appling/*` package see, record one change intent per change before reporting the task finished: `corepack pnpm change --bump <patch|minor|major> --summary "<one sentence for npm users>" <name>...`.
- Pick the bump from the change: breaking is minor below 1.0.0 and major from 1.0.0, a feature is patch below 1.0.0 and minor from 1.0.0, a fix, perf or refactor is patch.
- Record no intent for docs, tests, chores or style, for private packages, or for dependents that follow through `workspace:` ranges.
- Keep the intent file in the same commit as the change it describes.

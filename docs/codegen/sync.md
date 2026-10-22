---
title: Sync
description: Regenerate a project from the changed model without losing the work done in it, by merging every file three ways.
---

Generation writes a draft project once. When the model changes afterwards, `appling generate --sync` brings the project up to the model and keeps what you, or the [AI tools](../tools/ai.md) working through the [registry](registry.md), changed in it.

```sh
appling generate --sync models
```

## How it works

Every generation stores what it produced in the project's `.appling/baseline/`: the files and, in `.appling/baseline-tasks.json`, the registry. Sync then takes three versions of every file:

| Version | Where it comes from |
|---|---|
| base | the baseline of the last generation |
| yours | the project as it is now |
| model | a fresh generation of the current model, in a temporary folder |

| Case | Result |
|---|---|
| you did not change the file | the model's version replaces it |
| the model did not change the file | your version stays |
| both changed it, in different places | both changes, merged with `git merge-file` |
| both changed the same lines | the file gets conflict markers (`<<<<<<< yours`, `>>>>>>> model`) and the registry a task to resolve them |
| the model adds a file | it is added |
| the model no longer produces a file you did not change | it is removed; if you changed it, it stays |

Afterwards the fresh generation becomes the new baseline. Sync needs `git` on the `PATH`.

## Before the merge: migrations

Sync first applies the model's pending migration steps, exactly as [`--migrate`](migrations.md) does, so renames reach the database as renames. The files a framework owns as history are never merged; every extension lists them:

| Extension | Not synced |
|---|---|
| Django | `*/migrations/**`, `.venv/**`, `__pycache__`, `db.sqlite3`, `uv.lock` |
| Ash | `deps/**`, `_build/**`, `priv/repo/migrations/**`, `priv/resource_snapshots/**`, `priv/static/**`, `mix.lock` |
| Go | `go.sum` |
| Rust | `target/**`, `Cargo.lock` |

After a sync that added fields, create their migrations the usual way: `uv run python manage.py makemigrations` for Django, `mix ash.codegen <name>` for Ash.

## The registry after a sync

The registry comes from the fresh generation, with the work done since the last one kept: an entry you marked `done` stays `done` as long as what was missing is still the same, and attempts and notes carry over. New elements arrive as new entries; files with conflict markers get an entry `(sync) <file>`.

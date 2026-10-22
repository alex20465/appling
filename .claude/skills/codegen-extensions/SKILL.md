---
name: codegen-extensions
description: Internals of the code generation core (packages/codegen) and its Django 6.1 and Ash 3 extensions, plus the target framework behavior the generators depend on. Use when adding or changing a generator for a node kind, a migration mapping, a step phase, the registry, or when a generated Django or Ash project fails to build, migrate or expose an API.
metadata:
  anchors:
    - name: "@appling/codegen"
      version: repo
      researched: 2026-10-23
    - name: django
      version: "~=6.1.0"
      researched: 2026-10-23
    - name: djangorestframework
      version: "~=3.16 (resolves to 3.17)"
      researched: 2026-10-23
    - name: ash
      version: unpinned, 3.x from hex
      researched: 2026-10-23
---

# Codegen extensions

How steps run, how the registry is derived, and the target framework behavior the generators rely on.

## How steps run

Command steps run through `spawnSync` with no shell (no pipes, no globs); stdin comes only from `input`, and a missing `cwd` is created. The first non zero exit throws before `tasks.json` is written, and the half built out folder makes `generate` refuse to run again ("not empty") until it is deleted. The Ash project is created by `igniter.new` in cwd `..`, so the out folder's basename must equal `app(context)`. Source: `packages/codegen/src/run.ts`, `packages/cli/src/main.ts`, `packages/codegen-ash/src/naming.ts`.

## Phases in use

| Phase | Runs |
|---|---|
| 0 (default) | Django setup, apps, every Django template |
| 1 | Ash `belongs_to`, migration snapshots |
| 2 | every Ash `patch()`, `api_router.ex` |
| 3 | final migrations: Django `makemigrations`, Ash `ash.codegen initial_resources` |

Task steps have no phase and never run; they only become registry entries. Source: `packages/codegen/src/plan.ts`, `packages/codegen-django/src/index.ts`, `packages/codegen-ash/src/index.ts`.

## Registry status

No tasks means `generated` (this covers `[]`); templates or commands plus tasks mean `partial`; only tasks or `undefined` mean `todo`. `files` lists template files and command `creates` only. In `migrate()`, identical commands are deduped by their joined argv; tasks attach to the entry for `current ?? target` and are dropped silently when no entry exists. Change ids are `<migrationQn>#<index>` in `.appling/migrations.json`. Django reuses one `NNNN_appling_<block>.py` per block; Ash writes `<stamp>_appling_<block>.exs`. Source: `packages/codegen/src/plan.ts`, `migrate.ts`, both extensions' `migrations.ts`.

## Python files

`pythonFile` merges only `from X import a, b` lines and strips startapp's "# Create your ... here." comment; stdlib ordering comes from the fixed `STANDARD_LIBRARY` list. The Django tests fake the startproject and startapp files in `django.test.ts`. Source: `packages/codegen-django/src/files.ts`.

## Django 6

- Scheduled jobs use the `django.tasks` framework new in 6.0 (`@task`, `.enqueue()`). Without `TASKS` configured, the default `ImmediateBackend` runs tasks inline; Django ships no worker. Inside a transaction enqueue with `transaction.on_commit(partial(t.enqueue, ...))`. Source: https://docs.djangoproject.com/en/6.1/topics/tasks/
- Django 6 needs Python 3.12 or later; only `uv` is checked as a prerequisite, so `uv add django~=6.1.0` fails when uv picks an older interpreter. Since 6.0, startproject and startapp no longer write `DEFAULT_AUTO_FIELD`; `BigAutoField` is the default. Source: https://docs.djangoproject.com/en/6.1/releases/6.0/
- Rename migrations are written by hand (`RenameField`, `AlterField`) so `makemigrations` has nothing to guess. Source: `packages/codegen-django/src/migrations.ts`.

## Ash 3

- Update and destroy actions default to `require_atomic? true`; every generated update sets `require_atomic? false` as a blanket choice (AshStateMachine's `transition_state` is atomic). `default_accept` is `[]`, so action inputs are emitted as `argument`s. Source: https://ash.hexdocs.pm/upgrading-to-3-0.html
- Everything defaults to `public?: false`. Only attributes get the `public` modifier; `belongs_to` and `calculate` lines are private, so AshJsonApi (default fields: all public) does not expose them. `ash.gen.resource` on an existing resource merges with `--conflicts` defaulting to ignore, and default create and update actions accept only the public attributes given at creation. Source: https://ash.hexdocs.pm/Mix.Tasks.Ash.Gen.Resource.html
- `mix igniter.install ash_json_api` without Phoenix creates `<App>Web.AshJsonApiRouter` listing the domains that have the extension at install time (none yet) and adds `open_api_spex`. The generator writes its own `<App>.ApiRouter`, which Bandit serves; `AshJsonApi.Router` has its own `Plug.Parsers` for `application/vnd.api+json`. Source: https://github.com/ash-project/ash_json_api/blob/main/lib/mix/tasks/ash_json_api.install.ex
- `ash_postgres` prompts interactively to choose rename or drop and add, so `migrate()` writes the Ecto migration itself and then runs `ash_postgres.generate_migrations --snapshots-only`. Source: https://ash-postgres.hexdocs.pm/Mix.Tasks.AshPostgres.GenerateMigrations.html
- AshOban: generated query read actions enable only offset pagination; the trigger queue defaults to the resource short name plus trigger name; `scheduler_cron` defaults to every minute; upstream plans to require explicit module names because renames otherwise leave dangling jobs. Source: https://ash-oban.hexdocs.pm/dsl-ashoban.html

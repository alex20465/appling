---
paths:
  - packages/codegen/**
  - packages/codegen-django/**
  - packages/codegen-ash/**
---

# Codegen extensions

- Emit `CheckConstraint(condition=...)` only; Django 6.0 removed `check=`.
- Do not narrow `djangorestframework~=3.16` to `~=3.16.0`; Django 6 support arrived in DRF 3.17.
- Do not add Celery or django-fsm; jobs use `django.tasks` and transitions are plain `if`/`elif` chains raising `InvalidTransition`.
- Pass only JSON round trippable arguments to a Django task, never model instances or datetimes.
- Write `RunPython` with a module level function, not a lambda, and keep it out of a migration that also alters the schema.
- Never let `makemigrations` or `ash.codegen` infer a rename; write rename migrations by hand, as both `migrations.ts` do.
- Run every Ash mix command through `mix()`, which appends `--yes` so Igniter never prompts.
- Give an AshOban trigger a `read_action` with `keyset? true`, add its queue to the Oban config, and keep the explicit worker and scheduler module names.
- Never import app enums into a Django migration; inline the choices through `frozen()`.
- Seed every new patch target in the test harness; patch writers assume the file exists.
- Add any new stdlib module to `STANDARD_LIBRARY` in `files.ts`, or imports sort wrong.
- Keep work that must land in the first migrations below phase 3.
- Before changing these files, use the `codegen-extensions` skill.

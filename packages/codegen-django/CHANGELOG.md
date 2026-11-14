# @appling/codegen-django

## 0.1.3

### Patch Changes

- Read external settings and secrets from the environment, write .env.example and stop the app when a secret is missing.

- Generate tenants, actors, roles and policies with active test bodies for policies, transitions, invariants and preconditions.

- Add scenarios (given, when, then) that the simulator checks and generators turn into tests.

- Add query inputs with an input block, calls and REST GET parameters from path and query string.

- Add richer action effects: for, update, delete and create as.

- Updated dependencies:
  - @appling/codegen@0.1.3
  - @appling/model@0.1.3

## 0.1.2

### Patch Changes

- Roles become django-rules predicates and the actor entity becomes the user model.

- Updated dependencies:
  - @appling/codegen@0.1.2
  - @appling/model@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies:
  - @appling/codegen@0.1.1
  - @appling/model@0.1.1

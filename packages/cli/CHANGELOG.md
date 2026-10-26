# @appling/cli

## 0.2.1

### Patch Changes

- `appling graph` writes its whole output when piped into another program instead of stopping at 128 KB.

- `appling refs <qualified name>` prints an element's code references, and `appling refs --check` reports shifted, broken and orphaned ones with exit code 1.

- Updated dependencies:
  - @appling/codegen@0.1.1
  - @appling/lang@0.2.1
  - @appling/model@0.1.1

## 0.2.0

### Minor Changes

- Stable #id markers are removed from the language; elements are identified by their qualified name only, and the formatter no longer assigns ids.

### Patch Changes

- New simulate command answers reach, actors and risks questions about the behavior model.

- New graph command prints the validated semantic graph as JSON.

- New release command saves a graph snapshot, and later edits record migration steps for released elements.

- New generate command creates projects for the configured targets, carries migration steps into them and keeps them in sync with the model.

- Updated dependencies:
  - @appling/lang@0.2.0

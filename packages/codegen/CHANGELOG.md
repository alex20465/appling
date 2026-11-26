# @appling/codegen

## 0.2.2

### Patch Changes

- Generated code is rendered from Nunjucks templates that a project can override or extend block by block.

- plan adds one left to code registry task per annotation.

- Updated dependencies:
  - @appling/lang@0.5.0
  - @appling/model@0.1.6

## 0.2.1

### Patch Changes

- Updated dependencies:
  - @appling/model@0.1.5

## 0.2.0

### Minor Changes

- Only a `does` text on an event, action, machine or job adds a registry task (`implement what <Name> does`); `describe` texts become documentation through the new `aboutOf(node)`.

### Patch Changes

- Updated dependencies:
  - @appling/model@0.1.4

## 0.1.3

### Patch Changes

- Track implementation markers and code references of every model line, and diff two graphs.

- Add scenarios (given, when, then) that the simulator checks and generators turn into tests.

- Updated dependencies:
  - @appling/model@0.1.3

## 0.1.2

### Patch Changes

- Updated dependencies:
  - @appling/model@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies:
  - @appling/model@0.1.1

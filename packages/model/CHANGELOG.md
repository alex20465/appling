# @appling/model

## 0.1.1

### Patch Changes

- Make the edit operations usable in the browser for the IDE demo.

## 0.1.1

### Patch Changes

- Code references map model elements to file line ranges in `.appling/references.json`: `recordReferences`, `readReferences` and `resolveReferences`, which follows moved code by its anchor line.

- `Simulator.access(actor)` lists what one actor may do, with the deciding policies.

- `relevance(graph)` scores every module and top level declaration from 0 to 1, from its dependents and dependencies within its declared level; also exported from `@appling/model/relevance` for browsers.

- Updated dependencies:
  - @appling/lang@0.2.1

## 0.1.0

### Patch Changes

- Updated dependencies:
  - @appling/lang@0.2.0

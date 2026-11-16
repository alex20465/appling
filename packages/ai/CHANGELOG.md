# @appling/ai

## 0.2.2

### Patch Changes

- Updated dependencies:
  - @appling/codegen@0.2.1
  - @appling/lang@0.4.1
  - @appling/model@0.1.5
  - @appling/viz@0.3.1

## 0.2.1

### Patch Changes

- The bundled skills use `describe` for notes and `does` only on event, action, machine and job.

- Updated dependencies:
  - @appling/codegen@0.2.0
  - @appling/lang@0.4.0
  - @appling/model@0.1.4
  - @appling/viz@0.3.0

## 0.2.0

### Minor Changes

- Replace the IDE oriented tools with the read only inspector: proposals, requests and the playbook are removed (breaking); add agent sessions, visual tools and set_icons.

### Patch Changes

- Updated dependencies:
  - @appling/codegen@0.1.3
  - @appling/lang@0.3.0
  - @appling/model@0.1.3
  - @appling/viz@0.2.0

## 0.1.3

### Patch Changes

- Updated dependencies:
  - @appling/codegen@0.1.2
  - @appling/lang@0.2.2
  - @appling/model@0.1.2

## 0.1.3

### Patch Changes

- Updated dependencies:
  - @appling/viz@0.1.1

## 0.1.2

### Patch Changes

- Add tools to guide through the model with node trails, flowcharts and bubbles in the visualizer window.

## 0.1.2

### Patch Changes

- The `code_references` and `record_code_references` tools; the registry and reverse engineering skills record where each element is implemented and use relevance levels.

- Over stdio the MCP server opens a visualization window next to the session: `visualize`, `visual_selection`, `visual_reply` and `propose_edits`, which waits for the decision in the window.

- Updated dependencies:
  - @appling/codegen@0.1.1
  - @appling/lang@0.2.1
  - @appling/model@0.1.1

## 0.1.1

### Patch Changes

- New MCP tool language_reference serves the complete Appling language documentation, so assistants can learn the syntax before writing a model; the reverse engineering skill reads it first.

## 0.1.0

### Patch Changes

- Updated dependencies:
  - @appling/lang@0.2.0

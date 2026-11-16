# @appling/lang

## 0.4.1

### Patch Changes

- A field whose type is missing after a syntax error no longer crashes type checking, the graph and the inspector snapshot; the syntax error is reported instead.

## 0.4.0

### Minor Changes

- The `does` clause is renamed `describe` on every named element; `does` remains only on `event`, `action`, `machine` and `job` for the work their code has to do and is a syntax error elsewhere.

## 0.3.0

### Minor Changes

- Remove the playbook construct from the language (breaking).

### Patch Changes

- Export the layer map and fix typing of actor fields declared with different types and machine ownership validation speed.

- Declare the settings and secrets of an external, name vendors from interfaces and describe any element with a does clause.

- Add scenarios (given, when, then) that the simulator checks and generators turn into tests.

- Add query inputs with an input block, calls and REST GET parameters from path and query string.

- Add richer action effects: for, update, delete and create as.

## 0.2.2

### Patch Changes

- Keywords used as names lex as names: default, limit, messages, migration and is are valid names, and enum values can be qualified.

- Names in export lists are references, so rename, go to definition and find references cover them.

- Roles hold a condition on the actor, and actors bind to their entity with `is`.

- The language server keeps one document per real file across symlinked workspace paths.

## 0.2.1

### Patch Changes

- `entity link` marks a secondary entity such as a join record.

- Modules and declarations take a relevance level, core, supporting or peripheral, before their opening brace; a module passes its level to its members.

## 0.2.0

### Minor Changes

- Stable #id markers are removed from the language; elements are identified by their qualified name only, and the formatter no longer assigns ids.

### Patch Changes

- printRange prints the canonical text of a single element.

- A TextMate grammar is generated for editor integrations.

- A language server with canonical formatting and hover is available from @appling/lang/lsp and as the appling-language-server binary.

- Expressions are type checked, and actors have fields usable in expressions.

# @appling/lang

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

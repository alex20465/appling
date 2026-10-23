# @appling/lang

## 0.2.0

### Minor Changes

- Stable #id markers are removed from the language; elements are identified by their qualified name only, and the formatter no longer assigns ids.

### Patch Changes

- printRange prints the canonical text of a single element.

- A TextMate grammar is generated for editor integrations.

- A language server with canonical formatting and hover is available from @appling/lang/lsp and as the appling-language-server binary.

- Expressions are type checked, and actors have fields usable in expressions.

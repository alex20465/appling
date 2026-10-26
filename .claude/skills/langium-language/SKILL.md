---
name: langium-language
description: Langium 4 internals of the Appling language (packages/lang) and the model code that walks its AST (packages/model edit.ts, graph.ts). Use when changing the grammar, scope provider, validator, expression typer, printer, formatter or language server, when adding a reference kind or terminal, or when debugging scoping, rename or applyEdit rejections.
metadata:
  anchors:
    - name: langium
      version: 4.4.0
      researched: 2026-10-23
    - name: vscode-languageserver
      version: 10.1.2
      researched: 2026-10-23
    - name: "@appling/lang"
      version: repo
      researched: 2026-10-23
---

# Langium language

What a Langium 3 engineer gets wrong in this repo, and the internal contracts behind scoping, printing and edits.

## ScopeComputation names changed in Langium 4

3.x `computeExports`, `computeLocalScopes`, `processNode(PrecomputedScopes)` and `document.precomputedScopes` became `collectExportedSymbols`, `collectLocalSymbols`, `addLocalSymbol(MultiMap)` and `document.localSymbols` (a `LocalSymbols`). `appling-scope.ts` overrides the 4.x names and reads `localSymbols` in `scopeOf`. Source: `langium/lib/references/scope-computation.d.ts`, CHANGELOG 4.0.0 #1788 https://github.com/eclipse-langium/langium/blob/main/packages/langium/CHANGELOG.md

## Multi references are unsupported downstream

`ReferenceInfo.reference` is `Reference | MultiReference`; `[+Type:Rule]` stores targets in `.items`, not `.ref`. The repo has none. Adding one breaks silently: `graph.ts` `data()` checks only `isReference`, and the validator, graph edges and rename take `getReferenceNodes(...)[0]`, so they see one target. Source: `langium/lib/syntax-tree.d.ts`, CHANGELOG 4.0.0 #1509, `packages/model/src/graph.ts`, `packages/model/src/edit.ts`.

## Nested module visibility

The CLAUDE.md rule "across modules only exported members are visible" has four refinements for nested modules, verified with `buildSources`:

1. A nested module sees its enclosing module's unexported members by bare name.
2. `export b` in a parent exposes every named descendant of `b` as `a.b.*`, bypassing `b`'s own export list (`namedPaths` walks the whole subtree).
3. `b`'s own exports are visible as `a.b.X` even when `a` does not export `b`.
4. The outer module cannot reach inner members by a relative path (`b.Y`); `addLocalSymbol` stops at the module.

Source: `packages/lang/src/appling-scope.ts`.

## applyEdit rejects by error text

`applyEdit` compares error message strings as a multiset before and after. Existing errors do not block an edit, but an edit that changes an existing error's wording (renaming an element named in it) counts as a new error and is rejected. Every call builds fresh services twice through `buildSources`; nothing is cached. Source: `packages/model/src/edit.ts`, `packages/lang/src/appling-workspace.ts`.

## ExpressionTyper state

Actors and tenants are cached per services instance in a `WorkspaceCache`, cleared by any document change. `tenant` binds only when exactly one tenant exists in the workspace. `targets` is complete only after `checkModel` ran over every model, which is why `graph.ts` and `renameSplices` type all models first. Source: `packages/lang/src/appling-types.ts`.

## Int vs Decimal comes from the CST

The `NUMBER` value converter returns a JS number, so `1.0` becomes `1`. The typer decides Int vs Decimal from `$cstNode.text.includes('.')`. Keep that if the terminal changes. Source: `packages/lang/src/appling-types.ts`.

## Formatter and printer

`ApplingFormatter` implements `Formatter` directly and replaces the whole document with `print()`, so the editor matches `appling fmt`. Range formatting formats everything, on type formatting is off, nothing happens on lexer or parser errors. Source: `packages/lang/src/lsp.ts`.

The printer keeps comments because the hidden terminal whose regex matches whitespace is skipped (never in the CST) while other hidden terminals become hidden leaf nodes. Blank lines are read from leaf line numbers, never from whitespace tokens. Source: `langium/lib/parser/token-builder.js`, `packages/lang/src/appling-printer.ts`.

## LSP rename is partial

`lsp.ts` overrides only `Formatter` and `HoverProvider`, so Langium's `DefaultRenameProvider` handles F2 in the IDE. It changes cross references and the declaration but misses expression names, transition states, export lists, message keys and bound projection fields. Source: `packages/lang/src/lsp.ts`, `renameSplices` in `packages/model/src/edit.ts`.

## Relevance is a plain string property

`Relevance returns string: 'core' | 'supporting' | 'peripheral'` is assigned as `relevance=Relevance?` right before the opening brace of every top level declaration and module (at the end for `role`, `tenant` and `job`, between `roles` and the field block for `actor`). Being a scalar, it lands in `GraphNode.props.relevance` with no graph code; `relevance()` in `packages/model/src/relevance.ts` reads it and inherits it down through `contains` edges. The three words are listed in `Ident` so they stay valid names. A new declaration kind needs the same optional assignment, or it can only inherit its module's level. Source: `packages/lang/src/appling.langium`, `packages/model/src/relevance.ts`.

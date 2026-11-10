#!/usr/bin/env bash
# Adds the language scope test of docs/concept.md section 8 to Claude's context before an edit of the grammar
# or the language reference, so it holds even when the path rule was compacted away.
file=$(jq -r '.tool_input.file_path // empty')
case "$file" in
  */packages/lang/src/appling.langium|*/docs/language/*.md) ;;
  *) exit 0 ;;
esac
jq -n '{hookSpecificOutput: {hookEventName: "PreToolUse", additionalContext: "Language scope (docs/concept.md section 8, .claude/rules/language-scope.md): a construct belongs in the language only when a domain expert states it, it changes what the business allows or what happens, and the validator or simulator uses it. Name the three tests and their result in the issue or PR. What fails goes to the target options in appling.config.json or into the generated code (registry task with leftToCode), never into the grammar. docs/language must stay within the budget of packages/ai/test/language-budget.test.ts; only the maintainer raises it."}}'

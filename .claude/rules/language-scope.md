---
paths:
  - packages/lang/src/appling.langium
  - packages/lang/test/fixtures/constructs/**
  - docs/language/**
  - docs/concept.md
  - examples/**
---

# Language scope

- Add a language construct only when all three tests of `docs/concept.md` section 8 hold: a domain expert states it, it changes what the business allows or what happens, and the validator or simulator uses it.
- Name the three tests and their result in the issue or PR that adds a construct.
- Put what fails the tests into the target options in `appling.config.json` or into the generated code, never into the grammar.
- Never add syntax to close a registry task; mark work the model leaves to the code with `leftToCode` instead.
- Keep `docs/language/` within the budget of `packages/ai/test/language-budget.test.ts`; never raise the budget without the maintainer's explicit decision.
- Prefer extending or replacing an existing construct over adding a new keyword.

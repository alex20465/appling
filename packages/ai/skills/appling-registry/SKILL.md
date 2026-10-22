---
name: appling-registry
description: Work through the open tasks of a project generated from an Appling model, one registry entry at a time, until the related tests pass. Use when asked to finish, complete or implement a generated Appling project, or to work on its task registry (.appling/tasks.json). Needs the Appling MCP server (appling-mcp).
---

# Working through the Appling task registry

A project generated from an Appling model has a task registry in `.appling/tasks.json`: one entry per model element, with what was generated and what is still missing. Generation never leaves placeholders in the code, so the registry is the complete list of open work. Test skeletons for rules skip with a pointer to their entry.

Repeat until `registry_next` reports no open tasks:

1. Call `registry_next`. It returns the entry (qualified name, kind, status), what is missing, the model context of the element (its properties and related elements) and the files that produced it.
2. Read what you need: the generated files listed in the entry, `read_source` for the element's Appling source, `graph_query` for related elements. The model is the specification; do not change it to make the code easier.
3. Implement what is missing in the generated project, in the style of the code around it. When the missing work is a test body, write the test and remove the skip that points at this entry.
4. Call `run_tests`. Fix what fails until the tests related to this entry pass.
5. Call `registry_update` with status `done`. If you cannot finish, use `partial` with a note on what is left and why. An entry stops coming back after three attempts, so the note is what the next person reads.

Work on one entry at a time and keep changes to what the entry asks for. When an entry needs a decision only a person can make (credentials, an external system's real behavior, product choices), mark it `partial` with the question in the note and move on.

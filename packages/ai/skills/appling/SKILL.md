---
name: appling
description: Design, build and change an application through its Appling model with the appling MCP server. Use for every request about what the application does or should do, such as designing a new app ("I want a todo app"), adding a feature, a change request, a bug in behavior, or explaining how a part works, and before generating or changing code in an Appling project.
---

# Building an application with Appling

An Appling project describes the application in `.appling` files: five layers (domain, behavior, application, interfaces, experience) plus modules, roles, actors and tenants. The model is the specification and the code follows it. You work on the model through the appling MCP server and on the code through `appling generate`, the task registry and your normal tools.

## 1. Orient yourself

Before you answer or change anything, find out where the project stands:

| Look at | Tells you |
|---|---|
| `check` | Whether the model is valid. Fix errors before anything else |
| `graph_query` with `kind: "Module"` | The modules that exist; an empty starter module means a new application |
| `appling.config.json` | The stack: each `generate` target names an extension (`@appling/codegen-django`, `-ash`, `-go`, `-rust`) and an `out` folder |
| `<out>/.appling/tasks.json` | The application was generated: model and code now change together |
| `.appling/references.json`, `code_references` | Code that implements model elements, by file and line |
| Application code without a model | Derive the model first with the `appling-reverse` skill |

## 2. Learn the language

Appling is a new language, so never write it from memory. Call `language_reference` without a page for the list, read `overview` first, then the page of each layer before you write it (`domain`, `behavior`, `application`, `interfaces`, `experience`, `access`, `expressions`, `modules`, `relevance`, `descriptions`).

## 3. Design a new application

A request such as "I want to design a todo app" is a modeling task. The draft is the model, not code.

1. When the visual tools are there (an Appling agent session), report the start with `visual_status`, such as "Designing the todo app", and each following step the same way, with done and total when you know them.
2. Ask the person only what the business decides: who uses the application, what they need to do, which rules must always hold. Decide the modeling yourself.
3. Split the application into modules by bounded context, such as `tasks` and `accounts`.
4. Write each module with `write_model_file`, in layer order: enums, value types and entities; then actions, state machines, events and jobs; then queries, projections and use cases; then interfaces and pages. Add roles, actors and policies for every action and query someone runs. Add a `does` text only where the structure leaves something unclear, such as the vendor call behind an external operation or the format of a value; never restate what names, types and effects already say.
5. Call `check` after each file and fix every error before you go on.
6. Show each module as you finish it. The canvas already marks every declaration you add; draw a machine with the `machine` view of `visualize` and explain the decisions with `visual_bubble`.
7. Verify the behavior with `simulate`: every state reachable (`reach`), the right actors allowed (`actors`), no invariant at risk (`risks`), and an action on a sample record (`run`).
8. Mark what the business runs on as `core` (page `relevance`).

While only the model exists, apply model changes directly, without asking first.

## 4. Generate the application

When the model covers what the person wants and there is no generated project yet:

1. Make sure `appling.config.json` has a `generate` target for the stack. Install the extension (`@appling/codegen-<stack>`) if it is missing.
2. Run `npx appling generate --plan` and read which elements become `todo` or `partial`.
3. Run `npx appling generate`, then `npx appling release 0.1.0`, so later renames, type changes and removals become migration steps.
4. Finish the open work with the `appling-registry` skill: one registry task at a time until the tests pass, each reported with `visual_status` (`done` and `total` from the registry).

## 5. Change an existing application

Every feature, change request or behavior bug starts in the model:

1. Find the elements involved with `graph_query`, `read_source` and `code_references`.
2. Change the model with `edit` (`add`, `rename`, `retype`, `remove`, `set`), one operation at a time. A rejected edit comes back with the errors to fix. Use `write_model_file` only for a new module.
3. Check the change with `check` and `simulate`. The canvas marks the changed declarations and lists the change with its text differences; show related views with `visualize`.
4. Carry the change into the code:
   - When code generation covers it, run `npx appling generate --migrate` for renames, type changes and removals, or `npx appling generate --sync` for everything else, then work through the new registry tasks with the `appling-registry` skill.
   - When it does not (code that was not generated, or a target without that element), change the code by hand and record the lines with `record_code_references`.
5. Run the tests.

The direction also runs the other way: when you or the person change behavior in the code, change the model to match, so the model never says something the code does not do.

## 6. Explain how something works

Answer from the model, not from the code: find the elements with `graph_query`, read them with `read_source`, ask `simulate` about behavior. Show them with `visualize` and walk through them with one `visual_bubble` per step. Read the code only for how something is implemented, and say so when code and model disagree.

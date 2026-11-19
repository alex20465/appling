---
title: Start from an existing project
description: Derive an Appling model from an application you already have with appling init and an AI agent connected to the Appling MCP server, then review it and generate from it.
---

You do not have to write a model from scratch. An AI agent reads the code of your existing application and writes the Appling model for it, one module at a time. It works with any codebase that has a data model: Django, Ash, Rails, Spring, Express, Prisma and others.

No AI model knows Appling from its training, so the [MCP server](../tools/ai.md#mcp-server) gives the agent everything it needs: the complete language documentation, a tool that writes a model file only when the whole model still validates, and the [simulator](../tools/simulator.md) to compare the model's behavior with your code.

## What you need

- Node.js 24 or later.
- An AI agent that supports MCP. This guide uses [Claude Code](https://claude.com/claude-code); any MCP client works.

## 1. Set up the project

In the root folder of your existing project, run [`appling init`](new-project.md):

```sh
npx @appling/cli init
```

It asks for the project name, the coding agents to connect and the stack to generate later (pick none to decide later). It installs `@appling/cli` and `@appling/ai` as development dependencies, keeps the `package.json` you have, writes an empty starter module in `models/<name>.appling`, the configuration and the `.gitignore` entries, and connects each agent to the Appling MCP server with its rules and skills. See [What it writes](new-project.md#what-it-writes).

## 2. Connect the agent

There is nothing left to do for the agents `init` connected: the MCP server serves the project root, so the agent writes the model into `models/` and sees your code, your releases and your generate targets in the same folder. Claude Code asks once whether to use the servers of `.mcp.json`.

For another MCP client, install the package and register `npx appling-mcp .` from the project root; see [Other MCP clients](../tools/ai.md#other-mcp-clients).

## 3. Derive the model

Start Claude Code in the project root and run the prompt the server provides:

```
/mcp__appling__derive_model
```

In other clients, pick the `derive_model` prompt from the server's prompts. The same instructions are the `appling-reverse` skill, which `init` links into the agent's skills folder, so the agent also loads them when you ask in your own words, such as "reverse engineer this application into an Appling model".

The agent then works through these steps:

1. **Learn the language.** It reads the language pages through the `language_reference` tool before writing any source.
2. **Survey the code.** It finds where your application keeps its data model, allowed values, rules, behavior, reads, access checks, interfaces and pages, and groups them into modules by the apps or domains the code already has.
3. **Map to Appling.** Each finding becomes the construct that owns it in one of the [five layers](../language/overview.md):

   | Found in code | Appling |
   |---|---|
   | Table or model with identity | `entity` |
   | Embedded structure without identity | `value` |
   | Fixed set of values | `enum` |
   | Constraint that must always hold | `invariant` |
   | State field changed by specific operations | `state` field and `machine` |
   | Operation that changes data | `action` |
   | Domain event, scheduled job | `event`, `job` |
   | Reusable read, serializer | `query`, `projection` |
   | Call to another system, multi step process | `external`, `usecase` |
   | API routes, screens | `interface`, `page` |
   | Permission check | `policy` |

4. **Write and validate.** It writes one module per file with `write_model_file`, domain layer first, and checks the model after each file. A file that would add an error is not written; the agent gets the errors and fixes them.
5. **Record where it lives.** For each element it marks the declarations of the code it describes with an `@appling` comment, its [code references](../tools/references.md), so you, the inspector and later agents find the implementation of any element without searching.
6. **Compare behavior.** It asks the simulator whether each state is reachable the way the code reaches it and whether the right actors pass the policies.
7. **Report.** Where the code does something the model cannot say exactly, such as a rule spread over several functions or raw SQL, it models the closest correct form with a `//` comment that names the source file, and lists these places in its summary. When the code allows two readings, it asks you.

> [!TIP]
> For a large application, derive one part at a time: "Derive the model for the billing app only", then the next one. Modules that reference each other resolve across files.

## 4. Review the result

Check the model, then open the project in the [inspector](../tools/inspect.md) to explore it on the canvas:

```sh
npx appling check models
npx appling inspect
```

`check` reports the number of files and `0 error(s)`; the agent never leaves the model invalid. Read the comments the agent left and its summary of what it could not model exactly. The model now describes what your application does; correct it where the code does something by accident rather than by intent.

## 5. Keep going

- Cut a [release](../language/migrations.md) with `npx appling release 1.0.0 models` from the project root, so later renames and type changes, also the agent's, become migration steps.
- Check which code was written against an older version of its element: `npx appling refs --check`. See [Code references](../tools/references.md).
- [Generate](../codegen/overview.md) a project for Django, Ash, Go or Rust from the model.
- Keep working on the model with the agent: the same MCP server [edits](../tools/ai.md#tools) it through validated operations.

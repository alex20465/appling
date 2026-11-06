---
title: Start a new project
description: Set up a project with appling init so your coding agent designs, builds and changes the application through its Appling model.
---

`appling init` sets up a project for Appling and connects the coding agents you work with: Claude Code, Codex, OpenCode, Gemini CLI or Antigravity CLI. Afterwards the agent has the Appling MCP server, the `appling` skill and a short set of rules that send every request through the model first.

## Run it

In an empty folder, or in a new folder you name:

```sh
npx @appling/cli init todo
```

It asks for three things:

| Question | Becomes |
|---|---|
| Project name | The `name` in `package.json`, the starter module and the generate target folder. Lower case letters, digits, `-` and `_`, starting with a letter |
| Coding agents | The agents to connect, one or several |
| Stack | The code generation target: Django, Ash, Go or Rust, or decide later |

To run it without questions, pass all three as flags:

```sh
npx @appling/cli init todo --name todo --agents claude,codex --stack django
```

## What it writes

| File | Content |
|---|---|
| `package.json` | Created with the project name when the folder has none |
| `node_modules` | `@appling/cli`, `@appling/ai` and the stack's extension, installed as development dependencies with the project's package manager |
| `appling.config.json` | A `generate` target for the stack, with the output folder `build/<name>` |
| `models/<name>.appling` | An empty module named after the project, when the folder has no `.appling` file yet |

A `-` in the name becomes `_` in the module and the output folder, so `todo-app` gets the module `todo_app`.

Then, per agent:

| Agent | MCP server | Rules | Skills |
|---|---|---|---|
| Claude Code | `.mcp.json`, approved in `.claude/settings.json` | `CLAUDE.md` imports them | `.claude/skills/` |
| Codex | `.codex/config.toml` | `AGENTS.md` points to them | `.agents/skills/` |
| OpenCode | `opencode.json` | `instructions` in `opencode.json` | `.agents/skills/` |
| Gemini CLI | `.gemini/settings.json` | `GEMINI.md` imports them | `.agents/skills/` |
| Antigravity CLI | `.agents/mcp_config.json` | `AGENTS.md` points to them | `.agents/skills/` |

The rules and the skills are not copied. The configuration points into `node_modules/@appling/ai`: the rules file is `rules/appling.md`, and every skill folder of the package is linked into the agent's skills folder. When you update `@appling/ai`, every agent reads the new version.

Existing settings stay: init adds the `appling` server to a configuration that already has others, appends the rules line to an existing `CLAUDE.md`, `AGENTS.md` or `GEMINI.md`, and leaves links that already exist. Running it again changes nothing.

> [!NOTE]
> Codex and Gemini CLI start project MCP servers only in trusted folders. Trust the folder when the agent asks, or with `gemini trust` for Gemini CLI. Claude Code asks once whether to use the servers of `.mcp.json`.

## Work with the agent

Start the agent in the project folder and describe what you want, such as "I want to design a todo app". The rules tell the agent how to treat it:

- A design or a draft is an Appling model, not code. The agent asks you what the business decides, writes the model module by module, validates it and shows it in the [visualization window](../tools/ai.md#visualization-window).
- Code comes from the model through [code generation](../codegen/overview.md) with the stack in `appling.config.json`, and the [registry skill](../tools/ai.md#registry-skill) finishes what generation leaves open.
- Every later request, a feature, a change or a bug, starts as a change of the model.
- While only the model exists, the agent applies model changes directly, without asking.
- Once the code exists, model and code change together in both directions: the agent carries a model change into the code with `appling generate --migrate` or `--sync` where generation covers it, changes the code by hand otherwise, and brings changes made in the code back into the model.

The `appling` skill holds the details: how to find out where the project stands, how to learn the language with `language_reference`, the layer order for a new model, generating and releasing, and how to carry a change through model and code. See [AI tools](../tools/ai.md#appling-skill-and-rules).

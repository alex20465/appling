---
title: AI tools
description: Give AI assistants validated access to your model through the MCP server, finish generated projects with the registry skill, and chat with the model in the IDE.
---

`@appling/ai` connects AI assistants to an Appling workspace. It has three parts:

- an [MCP server](#mcp-server), `appling-mcp`, with tools to query the model, edit it through validated operations and work through a generated project's task registry,
- the [registry skill](#registry-skill), instructions for an agent that finishes a generated project one task at a time,
- the [IDE chat](#ide-chat), which runs the same model tools on a working copy and returns its changes as a proposal you review.

An assistant never edits `.appling` text directly. It changes the model with [edit operations](../reference/edit-operations.md), and every operation is validated: an edit that does not parse or adds an error is rejected with the reasons, so the model stays valid.

## MCP server

```sh
npm install --save-dev @appling/ai
```

```sh
appling-mcp [folder]                  # stdio
appling-mcp [folder] --http [port]    # Streamable HTTP on http://127.0.0.1:<port>/mcp
```

| Argument | Default | Meaning |
|---|---|---|
| `folder` | the current folder | The workspace: every `.appling` file below it, plus `appling.config.json` and `.appling/releases/` in it |
| `--http [port]` | off; port `4411` | Serve Streamable HTTP instead of stdio. Put the folder before `--http`, since the argument after it is read as the port |

Over stdio, the server serves one client on stdin and stdout. Over HTTP, it listens on `127.0.0.1` only, answers on the path `/mcp`, accepts only the `Host` headers `127.0.0.1:<port>` and `localhost:<port>` (DNS rebinding protection), and handles every request statelessly.

The server reads the files on every tool call, so it always sees the current text, including changes from the IDE or your editor. Edits it makes are written to the files at once.

### Claude Code

Add the server to the project (stdio):

```sh
claude mcp add appling -- npx appling-mcp .
```

Or start it over HTTP and point Claude Code at the address:

```sh
npx appling-mcp . --http 4411
claude mcp add --transport http appling http://127.0.0.1:4411/mcp
```

### Other MCP clients

Clients that start servers from a JSON configuration (such as Claude Desktop) take the command and its arguments. With `npx -p`, the package does not need to be installed:

```json
{
  "mcpServers": {
    "appling": {
      "command": "npx",
      "args": ["-p", "@appling/ai", "appling-mcp", "/path/to/your/project"]
    }
  }
}
```

Use an absolute folder here, since the client decides the working directory.

## Tools

The server registers nine tools. Each returns its result as JSON text.

### Model tools

These five tools are shared by the MCP server and the IDE chat.

| Tool | Input | Returns |
|---|---|---|
| `check` | none | `{ errors }`: one `file:line:column message` per error; an empty list means the model is valid |
| `graph_query` | `qn?`, `kind?`, `module?`, `search?` (all strings) | With `qn`: that [graph node](../reference/graph.md) with `contains`, `refersTo` and `referredBy`. Without: `{ count, elements }`, the nodes filtered by `kind` (such as `Entity`), `module` and a `search` text in the qualified name (case insensitive), at most 200 of them, each with `qn`, `kind` and `layer` |
| `read_source` | `qn` (string) | `{ source }`: the file name and the element's source text |
| `edit` | `operation` (object), `dryRun?` (boolean) | `{ ok: true, changed }` with the changed files, or `{ ok: false, errors }`. With `dryRun`, it validates without writing |
| `simulate` | `question`: `reach`, `actors`, `risks` or `run`; `machine?`, `state?`, `action?`, `record?`, `actor?`, `actorFields?`, `inputs?` | The [simulator](simulator.md)'s answer, with values it could not know as `"unknown"`; `{ error }` for an unknown element |

The `operation` of `edit` is one of the five [edit operations](../reference/edit-operations.md), chosen by `op`:

| `op` | Fields |
|---|---|
| `add` | `parent`: qualified name of the element to add to, such as `sales.Order`; `source`: Appling source of the new member, such as `note: Text?` |
| `rename` | `target`, `name` |
| `retype` | `target`: a field or parameter; `type`: Appling type, such as `Money` or `crm.Account[]` |
| `remove` | `target` |
| `set` | `target`; `property`: a property name as `graph_query` shows it, such as `default`, `condition` or `modifiers`; `value`: Appling source of the value, empty to remove the property |

An example call of `edit`:

```json
{ "operation": { "op": "rename", "target": "sales.Order.total", "name": "amount" } }
```

Edits are release aware: once the workspace has a release, renaming, retyping or removing a released domain element also appends a migration step. See [Edit operations](../reference/edit-operations.md#release-aware-edits).

### Authoring tool

| Tool | Input | Returns |
|---|---|---|
| `write_model_file` | `path`: a `.appling` path relative to the workspace; `source`: the complete file | `{ ok: true, written }`, or `{ ok: false, errors }` with the errors the file would add. A file is written only when the whole workspace still validates with it, and only inside the workspace |

It creates new modules, which the edit operations cannot, for example when [deriving a model](#reverse-engineering-skill) from an existing application.

### Registry tools

These three tools work on the [task registry](../codegen/registry.md) (`.appling/tasks.json`) of projects made by `appling generate`. The targets come from the `generate` section of `appling.config.json`, with each `out` folder taken relative to the workspace folder; targets without a registry are ignored.

| Tool | Input | Returns |
|---|---|---|
| `registry_next` | `target?`: output folder of a generate target, default the first one | `{ out, entry }`: the first entry in dependency order whose status is `todo` or `partial`, that has missing work and fewer than three attempts; or `{ done: "No open tasks." }` |
| `registry_update` | `qn` (string), `status` (`done`, `partial` or `todo`), `note?` (string), `target?` | The updated entry. It counts one attempt; `done` clears the missing work; the note is appended; an entry still open after its third attempt gets the note `stopped after 3 attempts` |
| `run_tests` | `target?` | `{ out, passed, output }`: runs the test command the extension recorded in the registry (for example `uv run python manage.py test`) in the project, with the last 4000 characters of its output |

The entry from `registry_next` carries everything an agent needs: the element's qualified name, kind and layer, the steps and files that produced it, and for each missing task its description with the element's properties and related elements.

### The implement_next_task prompt

The server also registers the MCP prompt `implement_next_task`. It carries the text of the registry skill below, so a client that supports prompts can start the workflow without installing the skill.

## Reverse engineering skill

`skills/appling-reverse/SKILL.md` guides an agent from an existing application to an Appling model: survey where the code keeps its data model, rules, behavior, reads, access checks, interfaces and pages; map each to its Appling construct; write one module per file with `write_model_file`, checking after each; compare the model's behavior with the code through `simulate`; and report what the model cannot say exactly, with comments that name the source files. The MCP prompt `derive_model` carries the same instructions. Install it like the registry skill, next to the MCP server pointed at the folder for the new model.

## Registry skill

The registry skill lives in the package at `skills/appling-registry/SKILL.md`. It tells an agent to repeat, until `registry_next` reports no open tasks:

1. Call `registry_next` for the next entry.
2. Read the generated files listed in it, `read_source` for the element and `graph_query` for related elements. The model is the specification; the agent does not change it to make the code easier.
3. Implement what is missing in the style of the code around it. For a test body, write the test and remove the skip that points at the entry.
4. Call `run_tests` and fix failures until the related tests pass.
5. Call `registry_update` with `done`, or `partial` with a note on what is left and why.

Entries that need a decision only a person can make (credentials, an external system's real behavior, product choices) end as `partial` with the question in the note.

To install it for Claude Code, copy the folder into your project's skills folder, next to the MCP server:

```sh
mkdir -p .claude/skills
cp -r node_modules/@appling/ai/skills/appling-registry .claude/skills/
```

Then ask Claude Code to finish the generated project; the skill's description makes it load for requests about the task registry.

## IDE chat

The AI tab of the [IDE](ide.md#the-ai-tab) runs one chat turn per message with the four model tools and a system prompt about Appling's layers. It uses the [AI SDK](https://ai-sdk.dev) and works with Anthropic and OpenAI models.

### Configure the model

Set the `ai` section of `appling.config.json` in the workspace folder:

```json
{
  "ai": { "provider": "anthropic", "model": "claude-opus-5-5" }
}
```

To use OpenAI, set `provider` to `openai` and `model` to an OpenAI model id.

| Key | Values | Default |
|---|---|---|
| `provider` | `anthropic` or `openai` | `anthropic` |
| `model` | A model id of that provider | `claude-opus-5-5` |

Each key falls back to its default on its own, so when you switch `provider`, also set a `model` of that provider. The settings are read on every chat turn; a change applies without restarting the IDE.

The API key comes from the environment of the IDE process, never from the configuration:

| Provider | Variable |
|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` |
| `openai` | `OPENAI_API_KEY` |

A missing key or an unknown model shows up as an error in the chat turn.

### Proposals

The chat never writes your files. Each turn starts from the files on disk, and the assistant's edits go to a working copy, where they are validated like any edit. A turn may take up to 25 model steps. When it ends with at least one successful edit, it returns a proposal:

| Part | Content |
|---|---|
| `operations` | The edit operations in the order they were made |
| `hunks` | Per changed file, the first changed line and the removed and added lines |
| `graph` | The qualified names of the elements `added`, `removed` and `changed` (properties differ) |

You accept or reject the proposal in the IDE. Accepting replays the operations through the IDE's edit path, so each lands in the editor as an undoable step.

```mermaid
flowchart TD
    A[Your message] --> B[Model turn with model tools]
    B --> C{Tool call}
    C -->|check, graph_query, read_source| D[Read the working copy]
    C -->|edit| E[applyEdit on the working copy]
    E -->|rejected| F[Errors back to the model]
    E -->|ok| G[Working copy updated, operation recorded]
    D --> B
    F --> B
    G --> B
    B -->|turn ends| H{Any operations?}
    H -->|no| I[Answer only]
    H -->|yes| J[Proposal: operations, hunks, graph diff]
    J --> K{You decide}
    K -->|Accept| L[Replay each operation via /api/edit, save files]
    K -->|Reject| M[Discard, files unchanged]
```

### Use the chat in your own tool

`chat(root, messages, model)` from `@appling/ai` runs one turn and yields events: `text` deltas, `tool` calls, at most one `proposal` at the end, and `error` messages. See [API](../reference/api.md).

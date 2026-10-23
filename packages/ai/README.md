# @appling/ai

Appling for AI assistants: an MCP server over an Appling workspace, a provider agnostic model adapter for the IDE chat, and the skill that works through a generated project's task registry.

## MCP server

```sh
appling-mcp [folder]                # stdio, for Claude Code, Claude Desktop or any MCP client
appling-mcp [folder] --http 4411    # Streamable HTTP on http://127.0.0.1:4411/mcp
```

For example in Claude Code: `claude mcp add appling -- npx appling-mcp .`

| Tool | Does |
|---|---|
| `check` | Validates the model and lists its errors |
| `graph_query` | One element with its properties, members and references, or elements filtered by kind, module or name |
| `read_source` | The Appling source of one element |
| `simulate` | Behavior questions: reachable states, which actors may trigger an action, invariants at risk, or a run of an action on a sample record |
| `language_reference` | The complete language documentation: the list of pages, or one page as Markdown |
| `write_model_file` | Creates or replaces one `.appling` file, only when the workspace still validates with it |
| `edit` | One edit operation (`add`, `rename`, `retype`, `remove`, `set`), validated, written to the files; `dryRun` only checks it |
| `registry_next` | The next open task of a generated project, with its model context |
| `registry_update` | Marks a task `done`, or `partial` with a note |
| `run_tests` | Runs the generated project's tests |

The prompt `implement_next_task` carries the registry workflow.

## Registry skill

`skills/appling-registry/SKILL.md` is an agent skill for working through `.appling/tasks.json` of a project made by `appling generate`: take the next open entry, implement what is missing, run the tests, record the outcome. Entries stop coming back after three attempts, with notes on what is left. Copy the folder into your agent's skills folder (for Claude Code, `.claude/skills/`) next to the MCP server.

## Reverse engineering skill

`skills/appling-reverse/SKILL.md` (also the MCP prompt `derive_model`) is an agent skill for deriving an Appling model from an existing application: survey the code, map it to the five layers, write and validate module by module, compare behavior with `simulate`, and report what the model cannot say exactly.

## Model adapter and chat

The IDE chat uses the [AI SDK](https://ai-sdk.dev). The model is set in `appling.config.json`, the API key comes from the provider's environment variable (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`):

```json
{ "ai": { "provider": "anthropic", "model": "claude-opus-5-5" } }
```

`chat(root, messages, model)` runs one turn with the model tools on a working copy. Edits are not written: the turn ends with a proposal (the operations, text hunks per file and the graph elements added, changed and removed) that the IDE shows for review.

## License

MIT

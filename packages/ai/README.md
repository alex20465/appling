# @appling/ai

Appling for AI assistants: an MCP server over an Appling workspace, a provider agnostic model adapter for the IDE chat, and the skill that works through a generated project's task registry.

## MCP server

```sh
appling-mcp [folder]                # stdio, for Claude Code, Claude Desktop or any MCP client
appling-mcp [folder] --http 4411    # Streamable HTTP on http://127.0.0.1:4411/mcp
```

For example in Claude Code: `claude mcp add appling -- npx appling-mcp .`

The server instructions tell the assistant that the model is the source of truth for business logic, so it asks the model before it searches the application code.

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
| `code_references` | Where an element and its members are implemented, by file and line range, with their status; without a name, every reference that is not current |
| `record_code_references` | Records the line ranges that implement an element in `.appling/references.json`, each with its first line as the anchor |

The prompt `implement_next_task` carries the registry workflow.

### Visualization window

Over stdio the server also drives a floating window (`@appling/viz`, Electron; macOS, Windows and Linux, through XWayland on Wayland). Ask Claude Code to show part of the model and the window opens at the top right of the main screen, above every other window.

| Tool | Does |
|---|---|
| `visualize` | Shows a `node` in the model tree, adding to the tree on screen so Claude can guide one node at a time, a flowchart of a `machine` or a `usecase`, or a card of an `action` or an `event` |
| `visual_bubble` | Places a note on an element or member of the view, or a code example with its file and line |
| `visual_selection` | The element selected in the window and the view on screen |
| `visual_reply` | Answers a question typed into the window |
| `propose_edits` | Shows edit operations as a proposal in the window and writes them only when accepted |

Every file and line in the window opens in your editor on click. Questions typed into the window reach the session as Claude Code channel messages. Channels are a research preview, so start Claude Code with `claude --dangerously-load-development-channels server:appling`.

## Registry skill

`skills/appling-registry/SKILL.md` is an agent skill for working through `.appling/tasks.json` of a project made by `appling generate`: take the next open entry, implement what is missing, run the tests, record where it is implemented and the outcome. Entries stop coming back after three attempts, with notes on what is left. Copy the folder into your agent's skills folder (for Claude Code, `.claude/skills/`) next to the MCP server.

## Reverse engineering skill

`skills/appling-reverse/SKILL.md` (also the MCP prompt `derive_model`) is an agent skill for deriving an Appling model from an existing application: survey the code, map it to the five layers (with rules for modeling access), write and validate module by module, record the code each element describes, compare behavior with `simulate`, and report what the model cannot say exactly.

## Model adapter and chat

The IDE chat uses the [AI SDK](https://ai-sdk.dev). The model is set in `appling.config.json`, the API key comes from the provider's environment variable (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`):

```json
{ "ai": { "provider": "anthropic", "model": "claude-opus-5-5" } }
```

`chat(root, messages, model)` runs one turn with the model tools on a working copy. Edits are not written: the turn ends with a proposal (the operations, text hunks per file and the graph elements added, changed and removed) that the IDE shows for review.

## License

MIT

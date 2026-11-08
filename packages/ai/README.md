# @appling/ai

Appling for AI assistants: an MCP server over an Appling workspace, the agent sessions and playbook of Appling Desktop, and the skills that design a model and work through a generated project's task registry.

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
| `registry_next` | The next open task of a generated project, with its model context; in an agent session it skips tasks other sessions claimed and claims it |
| `registry_update` | Marks a task `done`, or `partial` with a note |
| `run_tests` | Runs the generated project's tests |
| `code_references` | Where an element and its members are implemented, by file and line range, with their status; without a name, every reference that is not current |
| `record_code_references` | Records the line ranges that implement an element in `.appling/references.json`, each with its first line as the anchor |
| `implementation_status` | How far the model is implemented: counts per state and the elements that are not implemented or changed since the last generation |

The prompt `implement_next_task` carries the registry workflow.

### Agent sessions

The IDE server of each repo serves this MCP server at `/mcp` for agent sessions, authenticated by a session's bearer token: Appling Desktop opens a session per agent terminal. The session tools `session_set_label`, `session_set_status`, `session_claim`, `session_release`, `sessions_list`, `session_message`, `session_inbox`, `ide_context` and `ide_act` let agents label their work, keep its status, claim elements and files, see and message each other and act on the IDE; edits that touch another session's claim come back with a warning. Sessions also get the visual tools below, drawing on the repo's canvas in Desktop (`VisualHost`), with proposals decided in the app; `onToolCall` of `createMcpServer` lets the IDE attribute written files to the session. `MemorySessionStore`, `serveSessionStore` and `RemoteSessionStore` share one store across processes; `MemorySessionStore.adopt` takes back a session with its earlier token (an agent that kept running while Desktop restarted). See https://www.appling.tools/docs/tools/ai/#agent-sessions.

`@appling/ai/agents` starts agents for such sessions in an app's terminals, as Appling Desktop and the VS Code extension do: the built in presets (Claude Code, Codex, Gemini CLI, opencode) and custom ones from `agents.presets` (`agentPresets`), `launch` (the command, arguments, environment and files that wire a preset's agent to its session's MCP server and hooks, without touching the user's configuration), the `Gateway` every agent reaches (`/mcp` forwarded to the session's IDE server, `/hooks/<event>`), the status from hooks, terminal notifications and the exit (`reduce`, `hookSignal`, `notificationSignal`) and `answerKeys` for answering a waiting agent. `out/agents/hook.cjs` is the command hook client.

With a playbook store in the session scope (`SessionScope.playbook`), sessions also write the workspace's shared playbook: `playbook_open_chapter`, `playbook_add_steps`, `playbook_step_done`, `playbook_close_chapter` and `playbook_read` (`PLAYBOOK_INSTRUCTIONS` tells them not to interrupt the chapter being watched). `MemoryPlaybookStore(folder?)` keeps playbooks on disk, `servePlaybookStore` and `RemotePlaybookStore` share them across processes, `respondToStep` stores the user's response and delivers it to the session's inbox, and `openChapter(store, author, chapter)` writes chapters without MCP. See https://www.appling.tools/docs/tools/ai/#the-playbook.

### Visual tools

Agent sessions also get tools that draw on the repo's canvas in Appling Desktop. The stdio and `--http` servers have none of them: there is no window to draw in outside Desktop.

| Tool | Does |
|---|---|
| `visualize` | Shows a `node` in the model tree, adding to the tree on screen so the agent can guide one node at a time, a flowchart of a `machine` or a `usecase`, or a card of an `action` or an `event` |
| `visual_bubble` | Places a note on an element or member of the view, or a code example with its file and line |
| `visual_selection` | The element the person selected and the view on screen |
| `visual_reply` | Answers the person next to the session's view; their questions typed there reach the session's inbox as messages from User |
| `visual_status` | Shows the step the agent works on, with its progress; every model change is marked on the canvas by itself |
| `propose_edits` | Shows edit operations as a proposal in the app and writes them only when accepted |

## Appling skill and rules

`rules/appling.md` is a short, always loaded instruction: the model is the source of truth, every requirement goes through the model first, changes apply directly while only the model exists and go into model and code together once code exists, and in a Desktop agent session the work shows on the canvas. `skills/appling/SKILL.md` holds the knowledge: orient in the project, learn the language, design a new application layer by layer, generate it, and carry changes through model and code. `npx @appling/cli init` wires both into Claude Code, Codex, OpenCode, Gemini CLI and Antigravity CLI by reference into `node_modules`, so updating this package updates them.

## Registry skill

`skills/appling-registry/SKILL.md` is an agent skill for working through `.appling/tasks.json` of a project made by `appling generate`: take the next open entry, implement what is missing, run the tests, record where it is implemented and the outcome. Entries stop coming back after three attempts, with notes on what is left. Copy the folder into your agent's skills folder (for Claude Code, `.claude/skills/`) next to the MCP server.

## Reverse engineering skill

`skills/appling-reverse/SKILL.md` (also the MCP prompt `derive_model`) is an agent skill for deriving an Appling model from an existing application: survey the code, map it to the five layers (with rules for modeling access), write and validate module by module, record the code each element describes, compare behavior with `simulate`, and report what the model cannot say exactly.

## License

MIT

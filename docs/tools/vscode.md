---
title: VS Code
description: Work with Appling models in VS Code, with the read only inspector in a tab per project, jumps between the model, its code and the canvas, and agent sessions in VS Code terminals.
---

The Appling extension for VS Code brings the read only [inspector](inspect.md) into VS Code, next to your AI coding tool. It finds the Appling projects of your workspace, runs one inspector server per project and opens each project's model canvas in a tab of its own, with the Inspector, Playbook, Changes, Review, Code and Tasks panels as read only views in the Appling sidebar. The text stays in VS Code's own editors, with the [language server](editors.md#vs-code). Agents run as [agent sessions](ai.md#agent-sessions) in VS Code's terminals.

## Install

Build the extension from the repository and install the file it writes:

```sh
pnpm --filter "appling-vscode..." build
code --install-extension packages/vscode/out/appling.vsix
```

For end to end testing, link the package into your editors instead. Each rebuild then runs after **Developer: Reload Window**:

```sh
pnpm --filter appling-vscode host:link     # VS Code, Insiders and VSCodium, those that exist
pnpm --filter appling-vscode host:unlink
node packages/vscode/scripts/link.mjs ~/.vscode/extensions   # one extensions folder
```

`host:link` replaces an installed copy of the extension with a symlink to `packages/vscode` and registers it in the editor's `extensions.json`. `host:unlink` removes the link, so install the vsix again afterwards to keep the extension.

The extension starts when the workspace contains a `.appling` file or an `appling.config.json`, when you open a `.appling` file, or when you open its view.

## The Appling view

The Appling icon in the activity bar opens the Appling sidebar: **Projects** and **Agent Sessions**, and while an inspector tab is open the [panels](#the-panels) of the project shown, each a section you fold and unfold.

**Projects** lists every Appling project of the workspace, each with its modules. A project is a folder with an `appling.config.json`, or a workspace folder with `.appling` files outside such a folder. The description shows the project's folder, the number of errors in its model, `starting` while its inspector server starts, or `not running` when it failed (the reason is in its tooltip). Click a project, or run **Appling: Open the inspector** from the command palette, to open its inspector tab. Click a module to open the tab with that module selected on the canvas. The view follows new and removed model files; the refresh button in its title finds the projects again.

**Agent Sessions** lists the agent sessions with their status and project. See [Agent sessions](#agent-sessions).

### Initialize Appling

A project without `appling.config.json` is not set up yet: the Projects view marks it **not set up** with an **Initialize** button, and the extension suggests initializing it once per session (**Don't ask again** stops that for the project). In a workspace without an Appling model, the Projects view offers **Initialize Appling**. It runs [`appling init`](../getting-started/new-project.md) in the workspace folder, in a terminal: it asks for the project name, the coding agents to connect and the stack, then writes the starter module when there is none, `appling.config.json` with the stack's generate target, the agents' configuration (such as `.mcp.json` for Claude Code) and the `.gitignore` entries, and installs the packages. The extension brings its own `appling` command line for this. Once the folder holds the model, its inspector tab opens. With several workspace folders you pick one first.

## The inspector tab

Each project's tab shows the [inspector](inspect.md)'s canvas and task board; its floating inspector is the **Inspector** view in the sidebar. The tab keeps its state while it is in the background. Everything that opens a file opens it in VS Code, in the editor group beside the tab. Selecting an element on the canvas changes nothing in your editors: you open its source or its code when you ask for it. Nothing in the tab or the panels changes the model; you edit the text in VS Code's editors or through your agent.

### The panels

The sidebar shows the panels of the inspector tab you used last, as read only VS Code trees. A click on an element selects it on the canvas; the canvas's selection shows in **Inspector**.

| Panel | Shows | Does |
|---|---|---|
| **Inspector** | The selected element: kind and layer, its change, implementation state and code, what an action does and who may trigger it, what an actor may do, an entity's actions, a machine's reachable states, its properties, members, what uses it and what it uses | The title buttons open the source and the code |
| **Playbook** | The [playbooks](ai.md#playbooks) of the agent sessions: each with its steps, the one that plays marked; the badge counts the playbooks | A step opens the playbook on the canvas and plays that step: its element is selected and its description shows in a bubble |
| **Changes** | Every model file changed since the last commit (outside git or before the first commit, since the server started) with the session that wrote it and its changed elements; the badge counts them | A file opens VS Code's diff against the last commit; nothing accepts or reverts a change |
| **Review** | The model changes and the changed files since a revision | Compare with any commit, mark on the canvas or not; text diffs open in VS Code's diff editor |
| **Code** | The implementation counts, each target with when it was generated, and the elements new or changed since the last generation | An element selects it on the canvas; there is no generation run or log |
| **Tasks** | Only the open tasks of every target's [registry](../codegen/registry.md): each element with its status, attempts and claiming session, what it still misses and its notes; the badge counts them | A task selects its element; the Inspector lists the selected element's tasks too |

| In the tab or a panel | Opens in VS Code |
|---|---|
| **Open source** | The element's declaration in its `.appling` file |
| **Open code**, or a code reference | The element's code, at its lines (see [Code references](references.md)) |
| A text diff in Review or the Inspector | VS Code's diff editor between the revision and the working tree |
| A changed file in Changes | VS Code's diff editor between the last commit and the file now |
| A claim ring on the canvas | The session's terminal |
| An agent's `ide_act` with `open` and a file | The `.appling` file at the line |

To find an element, use VS Code's **Go to Symbol in Workspace** (Ctrl+T): the language server lists every element by its qualified name, `sales.Order.status`. VS Code's search finds the text.

Changed elements and files carry Source Control's letters and colours (A added, M modified, D deleted) in every panel.

### Generating

The inspector does not generate. Run [`appling generate`](cli.md#generate) in a terminal, or let your agent do it; the canvas marks and the **Code** and **Tasks** panels follow.

### Theme

The tab follows VS Code's theme: the inspector takes its light or dark palette from the theme's kind and VS Code's colours and fonts for its surfaces, lines, text and code, and changes with the theme. The accent and layer colours stay Appling's, in their light or dark variant. See [Theme](inspect.md#theme).

## From the editor into the inspector

A `.appling` file shows the Appling icon in the editor's title bar, **Appling: Show in the inspector**. It opens the file's project tab with the element at the cursor selected.

The editor also shows the [implementation state](implementation.md) of every project:

- a gutter mark on each model line that declares an element: implemented, partial, unimplemented, shifted or broken, with the element in its hover,
- a CodeLens **Appling: sales.Order** above each code range that implements an element; it selects the element in its project's tab,
- a CodeLens **Open code** on model lines whose element has code, and the command **Appling: Open the code of this element** for the element at the cursor.

Each inspector server sends the marks after every model or reference change.

## Agent sessions

Agents you start yourself, in any terminal, work on the model through the Appling MCP server that `appling init` wires into their configuration. **Appling: New agent session**, from the command palette, starts an agent session instead: it asks for the agent and, with several projects, the project, then starts the agent in a new VS Code terminal in the project's folder. Claude Code, Codex, Gemini CLI and opencode are built in.

Each session gets its own MCP session of the workspace with a token. The extension hands the agent the MCP server through its command line or environment and configuration files in the session's own folder in the extension's storage, and never edits your configuration files:

| Agent | MCP server | Status |
| :- | :- | :- |
| Claude Code | `--mcp-config` (HTTP with an `Authorization` header) | HTTP hooks in `--settings`: PermissionRequest, Notification, Stop, StopFailure, UserPromptSubmit |
| Codex | `-c mcp_servers.appling.url=…` with the token in `APPLING_MCP_TOKEN` | its TUI notifications as OSC 9 (`-c tui.notification_method="osc9"`) |
| Gemini CLI | a system settings file of the session's own (`GEMINI_CLI_SYSTEM_SETTINGS_PATH`, merged over the machine's) | its BeforeAgent, AfterAgent and Notification hooks |
| opencode | `OPENCODE_CONFIG_CONTENT` (a remote server with headers) | a plugin in `OPENCODE_CONFIG_DIR` for permission and idle events |

| Where | Shows or does |
|---|---|
| Agent Sessions view | Each session with its label (the agent's name until the agent sets one), status and project; click it for its terminal, the speech bubble answers a waiting one, the cross ends it |
| Notification | A session that waits while its terminal is out of view says so, with **Allow** and **Deny** for a permission, **Reply…** for anything else, and **Show** for its terminal |
| Inspector tab | The claims of every session on the canvas and on the task board, the files they wrote in the Changes panel, their views |

The sessions of all projects share one session store, so they see each other's labels, status and claims across projects. The workspace is the `.code-workspace` file, or the first folder.

When you start Claude Code yourself in a VS Code terminal, in a project's folder or a folder that holds the only project, the extension offers to add the Appling MCP server to it, so it gets a session of its own with the [visual tools](ai.md#visual-tools). **Add the MCP server** runs `claude mcp add` with the local scope for that folder, which is the one case where the extension changes an agent's configuration: the entry holds the session's token and replaces a project wide `appling` server while it is there. It connects when the agent reloads its MCP servers or restarts in the terminal. The session shows in the Agent Sessions view; it lasts through restarts of the agent in that terminal and covers every Claude Code started in the same folder, so the extension asks once per folder and window, whatever you answer. When the terminal closes, you end the session or the window closes, the extension removes the entry with `claude mcp remove`. This needs VS Code's shell integration, and the other agents have no such command, so start those as agent sessions.

The agent runs as a command of your shell through VS Code's shell integration, which lets the extension see the agent's terminal notifications (OSC 9, OSC 777) and its exit. Without shell integration the command is typed into the shell; the status then comes from the agent's hooks and MCP alone. VS Code shows extensions no terminal input, so when you answer a prompt by typing into the terminal, the session stays marked as waiting until the agent reports again. Answering from the notification or the view clears it at once. Closing the terminal ends the session and releases its claims. Sessions end with the VS Code window.

Add your own presets, or change the built in ones, in the `appling.agents.presets` setting:

```json
{
  "appling.agents.presets": [
    { "name": "Aider", "command": "aider", "args": ["--mcp-server", "{mcpUrl}"] },
    { "name": "Claude Code", "command": "claude", "args": ["--model", "opus"], "wiring": "claude" }
  ]
}
```

`wiring` is `claude`, `codex`, `gemini`, `opencode` or `env` (the default): with `env` the agent gets `APPLING_MCP_URL`, `APPLING_MCP_TOKEN` and `APPLING_HOOK_URL`, the arguments may use `{mcpUrl}`, `{token}` and `{hookUrl}`, and any OSC 9 or OSC 777 notification marks it as waiting. `answers` sets the keys of `allow`, `deny`, `option` (`{n}` for the number) and `submit`.

## Remote windows

In a Remote SSH, WSL or dev container window the extension runs where the files are. VS Code forwards each inspector server's port to your machine, and the extension tells the server to trust the forwarded address, so the tab works the same. VS Code in the browser is not supported: its tabs reach forwarded ports over HTTPS, which the inspector server does not accept.

## How it works

The extension starts the inspector server of `@appling/inspect` (bundled into the extension) once per project, on VS Code's own Node, with the shared session store served over its IPC channel. The tab is a webview with the server's page in an iframe opened with `?host=frame`. The page sends its requests and the panels' state to the extension with `postMessage` and takes the selection, the jumps, the panels' actions and VS Code's theme the same way; the extension checks every path it receives against the project's folder (code may also sit next to it) before it opens a file. The server only lets VS Code's webviews embed its page (`Content-Security-Policy: frame-ancestors`). See [Security](inspect.md#security).

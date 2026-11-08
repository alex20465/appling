---
title: VS Code
description: Work with Appling models in VS Code, with the repo view in a tab per project, jumps between the model, its code and the canvas, and agent sessions in VS Code terminals.
---

The Appling extension for VS Code brings the [repo view](ide.md) into VS Code. It finds the Appling projects of your workspace, runs one IDE server per project and opens each project's model canvas in a tab of its own, with the inspector, Changes, Playbook, Review, Code and Tasks panels as native views in the Appling sidebar. The text stays in VS Code's own editors, with the [language server](editors.md#vs-code). Agents run as [agent sessions](ai.md#agent-sessions) in VS Code's terminals, as they do in [Appling Desktop](desktop.md#agent-sessions).

Inside the code view of Appling Desktop the extension runs only the language server and the bridge to Desktop's canvas, since Desktop shows the repo view itself.

## Install

Build the extension from the repository and install the file it writes:

```sh
pnpm --filter "appling-vscode..." build
code --install-extension packages/vscode/out/appling.vsix
```

The extension starts when the workspace contains a `.appling` file or an `appling.config.json`, when you open a `.appling` file, or when you open its view.

## The Appling view

The Appling icon in the activity bar opens the Appling sidebar: **Projects** and **Agent Sessions**, and while an IDE tab is open the [panels](#the-panels) of the project shown, each a section you fold and unfold.

**Projects** lists every Appling project of the workspace, each with its modules. A project is a folder with an `appling.config.json`, or a workspace folder with `.appling` files outside such a folder. The description shows the project's folder, the number of errors in its model, `starting` while its IDE server starts, or `not running` when it failed (the reason is in its tooltip). Click a project to open its IDE tab. Click a module to open the tab with that module selected on the canvas. The view follows new and removed model files; the refresh button in its title finds the projects again.

**Agent Sessions** lists the agent sessions with their status and project. See [Agent sessions](#agent-sessions).

### Initialize Appling

A project without `appling.config.json` is not set up yet: the Projects view marks it **not set up** with an **Initialize** button, and the extension suggests initializing it once per session (**Don't ask again** stops that for the project). In a workspace without an Appling model, the Projects view offers **Initialize Appling**. It runs [`appling init`](../getting-started/new-project.md) in the workspace folder, in a terminal: it asks for the project name, the coding agents to connect and the stack, then writes the starter module when there is none, `appling.config.json` with the stack's generate target, the agents' configuration (such as `.mcp.json` for Claude Code) and the `.gitignore` entries, and installs the packages. The extension brings its own `appling` command line for this. Once the folder holds the model, its IDE tab opens. With several workspace folders you pick one first.

## The IDE tab

Each project's tab shows the [repo view](ide.md)'s canvas, without its own source pane and side panels: there is no **Source** button, because the text is in VS Code, and the panels are in the sidebar. The tab keeps its state while it is in the background. Everything that opens a file opens it in VS Code, in the editor group beside the tab. Selecting an element on the canvas changes nothing in your editors: you open its source or its code when you ask for it.

### The panels

The sidebar shows the panels of the IDE tab you used last, as VS Code trees. A click on an element selects it on the canvas; the canvas's selection shows in **Inspector**. A banner or chip on the canvas (proposals waiting, chapters to watch, a generation) opens its panel.

| Panel | Shows | Does |
|---|---|---|
| **Inspector** | The selected element: kind and layer, its change, implementation state and code, what an action does and who may trigger it, what an actor may do, an entity's actions, a machine's reachable states, its properties, members, what uses it and what it uses | The title buttons open the source and the code, rename, change the type, add a member and remove the element; each property line edits, adds or removes in an input box. Edits are VS Code edits of the files, saved and undoable |
| **Changes** | Proposals with their hunks and model changes, then every changed file with the session that wrote it and its elements; the badge counts them | Accept or reject a proposal (with a comment), accept or revert a file, accept all; a file opens VS Code's diff against the text you last accepted |
| **Playbook** | The chapters with their steps; the badge counts the unwatched ones | A chapter or step plays it on the canvas; replay, the session's terminal and the session's changes are its buttons |
| **Review** | The model changes and the changed files since a revision | Compare with any commit, mark on the canvas or not; text diffs open in VS Code's diff editor |
| **Code** | The implementation counts, the targets, the elements changed since the last generation (with check boxes) and the running generation | **Generate…** picks what: the outstanding elements, the selected one, the checked ones or everything; the log opens in the **Appling Generation** output |
| **Tasks** | The open tasks of every target's [registry](../codegen/registry.md): each element with its status, attempts and claiming session, what it still misses and its notes; the badge counts them | A task selects its element; the Inspector lists the selected element's tasks too |

| In the tab or a panel | Opens in VS Code |
|---|---|
| **Open source** | The element's declaration in its `.appling` file |
| **Open code**, or a code reference | The element's code, at its lines (see [Code references](references.md)) |
| A text diff in Review or the Inspector | VS Code's diff editor between the revision and the working tree |
| A changed file in Changes | VS Code's diff editor between the text you last accepted and the file now |
| A chapter's session, or a claim ring on the canvas | The session's terminal |
| A chapter's diff from another project | That project's tab, with Changes showing that session's files |
| An agent's `ide_act` with `open` and a file | The `.appling` file at the line |

To find an element, use VS Code's **Go to Symbol in Workspace** (Ctrl+T): the language server lists every element by its qualified name, `sales.Order.status`. VS Code's search finds the text.

Changed elements and files carry Source Control's letters and colours (A added, M modified, D deleted) in every panel.

### Generating

Generate the application first, from the button under the path at the top left of the canvas, the Inspector or **Code**; then the canvas's button, the Inspector and **Code** generate elements one by one. Without a stack yet, a quick pick asks for one, adds its target to `appling.config.json` and generates (see [Choosing a stack](ide.md#choosing-a-stack)). The extension comes with the generators; when the project has none installed, it offers to install the chosen one with npm (`npm install --save-dev`), in a terminal, which pins its version for the project.

### Theme

The tab follows VS Code's theme: the IDE takes its light or dark palette from the theme's kind and VS Code's colours and fonts for its surfaces, lines, text and code, and changes with the theme. The accent and layer colours stay Appling's, in their light or dark variant. See [Theme](ide.md#theme).

## From the editor into the IDE

A `.appling` file shows the Appling icon in the editor's title bar, **Appling: Show in the IDE**. It opens the file's project tab with the element at the cursor selected.

The editor also shows the [implementation state](implementation.md) of every project:

- a gutter mark on each model line that declares an element: implemented, partial, unimplemented, shifted or broken, with the element in its hover,
- a CodeLens **Appling: sales.Order** above each code range that implements an element; it selects the element in its project's tab,
- a CodeLens **Open code** on model lines whose element has code, and the command **Appling: Open the code of this element** for the element at the cursor.

Each IDE server sends the marks after every model or reference change.

## Agent sessions

Agents you start yourself, in any terminal, work on the model through the Appling MCP server that `appling init` wires into their configuration. **Appling: New agent session**, from the command palette, starts an agent session instead: it asks for the agent and, with several projects, the project, then starts the agent in a new VS Code terminal in the project's folder. Claude Code, Codex, Gemini CLI and opencode are built in. Each session gets its own MCP session of the workspace and is wired exactly as in [Appling Desktop](desktop.md#agent-sessions), without touching your configuration files: through its command line, environment and configuration files in the session's own folder in the extension's storage.

| Where | Shows or does |
|---|---|
| Agent Sessions view | Each session with its label (the agent's name until the agent sets one), status and project; click it for its terminal, the speech bubble answers a waiting one, the cross ends it |
| Notification | A session that waits while its terminal is out of view says so, with **Allow** and **Deny** for a permission, **Reply…** for anything else, and **Show** for its terminal |
| IDE tab | The claims of every session on the canvas, the files they wrote in the Changes tab, their views, proposals and playbook chapters |

The sessions of all projects share one session store and one playbook, kept in the extension's global storage, so they see each other's labels, status and claims across projects as in a Desktop workspace. The workspace is the `.code-workspace` file, or the first folder.

The agent runs as a command of your shell through VS Code's shell integration, which lets the extension see the agent's terminal notifications (OSC 9, OSC 777) and its exit. Without shell integration the command is typed into the shell; the status then comes from the agent's hooks and MCP alone. VS Code shows extensions no terminal input, so when you answer a prompt by typing into the terminal, the session stays marked as waiting until the agent reports again. Answering from the notification or the view clears it at once. Closing the terminal ends the session and releases its claims. Sessions end with the VS Code window.

Add your own presets, or change the built in ones, in the `appling.agents.presets` setting, with the same shape as Desktop's `agents.presets`:

```json
{
  "appling.agents.presets": [
    { "name": "Aider", "command": "aider", "args": ["--mcp-server", "{mcpUrl}"] },
    { "name": "Claude Code", "command": "claude", "args": ["--model", "opus"], "wiring": "claude" }
  ]
}
```

## Remote windows

In a Remote SSH, WSL or dev container window the extension runs where the files are. VS Code forwards each IDE server's port to your machine, and the extension tells the server to trust the forwarded address, so the tab works the same. VS Code in the browser is not supported: its tabs reach forwarded ports over HTTPS, which the IDE server does not accept.

## How it works

The extension starts the IDE server of `@appling/ide` (bundled into the extension) once per project, on VS Code's own Node, with the shared session and playbook store served over its IPC channel. The tab is a webview with the server's page in an iframe opened with `?host=frame`. The page sends its requests and the panels' state to the extension with `postMessage` and takes the selection, the jumps, the panels' actions and VS Code's theme the same way; the extension checks every path it receives against the project's folder (code may also sit next to it) before it opens a file. The server only lets VS Code's webviews embed its page (`Content-Security-Policy: frame-ancestors`). See [Security](ide.md#security).

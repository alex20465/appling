---
title: Desktop
description: Install Appling Desktop, the native app that opens many repos with the model canvas as the main area of each, and keep it up to date.
---

Appling Desktop is a native app for Linux, Windows and macOS. It groups repos into workspaces, runs an IDE server once per repo and shows its [repo view](ide.md), with the model canvas as the main area. It replaces the browser IDE and the floating visualization window of earlier versions. It is in development: the builds come from the `desktop-v<version>` tags of the repository, and there is no release yet.

## Install

Download the file for your system from the [releases](https://github.com/alex20465/appling/releases) of the repository. Desktop releases are titled **Appling Desktop**.

| System | File | Install |
|---|---|---|
| Linux (x64) | `Appling-<version>-linux-x86_64.AppImage` | Make it executable (`chmod +x Appling-*.AppImage`) and run it. No installation needed |
| Windows (x64) | `Appling-Setup-<version>-x64.exe` | Run the installer. It installs for your user only, without admin rights |
| macOS (Apple silicon) | `Appling-<version>-mac-arm64.dmg` | Open the dmg and drag Appling into Applications |
| macOS (Intel) | `Appling-<version>-mac-x64.dmg` | Same as above |

The builds are not code signed yet, so each system warns once:

- **macOS** says the app cannot be opened because the developer cannot be verified. Right click Appling in Applications, choose **Open**, then **Open** again. Or remove the quarantine flag once: `xattr -dr com.apple.quarantine /Applications/Appling.app`.
- **Windows** SmartScreen says it protected your PC. Click **More info**, then **Run anyway**.
- **Linux** AppImages need FUSE 2 (`libfuse2` on Debian and Ubuntu). Without it, run the AppImage with `--appimage-extract-and-run`. If it stops with a message about the sandbox (Ubuntu 24.04 restricts unprivileged user namespaces), start it with `--no-sandbox`.

## Open repos

Start Appling from its launcher, or from a terminal with folders and `.code-workspace` files:

```sh
./Appling-0.1.0-linux-x86_64.AppImage ~/work/shop ~/work/crm
```

Each `.code-workspace` file opens as a workspace, and each folder joins the active workspace. A second start hands its paths to the running app and quits. `--version` prints the version and quits without opening a window.

From a clone of the repository, `node packages/desktop/out/bin.js [paths...]` does the same after `pnpm build`.

## Model and code

The code view of a repo (Code OSS with the Appling extension) marks every model line with how far its element is implemented and puts a CodeLens on implementing code that selects its element on the canvas. **Open code** in the IDE, or a click on a gutter mark, opens the element's code in the code view. See [Seed to code](implementation.md).

## Windows and monitors

Every window has the rail and the switcher. The first window is the main window: it holds every workspace no other window holds, and closing it quits the app.

| To | Do |
|---|---|
| Put a workspace or a repo in a window of its own | Drag it out of the rail and drop it outside every window, or right click it and choose **Move to New Window** |
| Move it into another window | Drop it on that window, or right click it and choose **Move to Window** |
| Move the code view or the terminal panel of a repo | Right click the repo, then **Move Code** or **Move Terminal** |
| Dock it back | Right click the moved pane and choose **Dock Back**, drag it back, or close its window |

A moved workspace takes its repos along. A moved repo takes its canvas: the new window shows it as a column, and its button in the old rail turns dashed. Closing a window gives everything in it back to the main window, so nothing closes with it.

Moving never reloads anything: the canvas, its selection, the code view and agent sessions stay as they were.

Appling saves which window holds what and where every window is, once per monitor setup, and restores it at the next start. A window whose monitor is gone opens on the primary display.

## Terminals

Every repo has its own terminals in a panel under its canvas. **Terminal › Toggle Terminal Panel** (`` Ctrl+` ``) opens and closes it, **New Terminal** (`` Ctrl+Shift+` ``) adds a tab and **Split Terminal** (`Ctrl+Shift+5`) puts a terminal next to the focused one. The terminal is the one VS Code uses (xterm.js): true colour, mouse, images, clipboard and hyperlinks work, and the shortcuts of the app menu stay out of its way, so `Ctrl+R` or `Ctrl+W` reach the shell, vim or tmux.

- New terminals start the shell of `$SHELL`, or another profile from the ▾ menu. Profiles are the shells of the system and those in VS Code's `terminal.integrated.profiles.*` settings.
- In bash, zsh and fish, Appling knows every command, its exit status and the folder it ran in: the tab shows the running command and a dot for how the last one ended, and `Ctrl+Up` and `Ctrl+Down` jump between commands.
- Ctrl+click (Cmd+click on macOS) opens a URL in the browser and a file path in the code view.
- Terminals and agent sessions keep running when the app closes or crashes. At the next start they come back in their tabs, with their screen and scrollback. To end them with the app instead, check **Terminal › End Terminals with the App**.

### While the app is closed

The pty host, the background process that owns the terminals, keeps watching them. When a program asks for attention with an OSC 9 or OSC 777 notification (Claude Code and Codex do when they wait for you) and the app is not attached to it, the host shows a desktop notification:

- **Linux**: through `org.freedesktop.Notifications`. Where the notification server offers inline replies (KDE Plasma, for one), the notification has a reply field; otherwise `notify-send` shows it with an **Open** action.
- **macOS**: a dialog with **Open** and a reply field.
- **Windows**: a toast with **Open** and a reply field.

Clicking it (or **Open**) starts Appling at that session: its repo, its tab, the terminal panel open. A reply is typed into the session followed by Enter. Each wait notifies once; typing into the session clears it.

For a remote repo the pty host on the other machine shows nothing there. While Appling is connected to the repo, it shows the notification on your machine instead; a click shows the repo, and a reply goes to the remote session.

To see or stop sessions without the app, use the `appling-pty-host` command (from a clone of the repository, `node packages/pty-host/out/main.js`):

```sh
appling-pty-host list            # id, status, pid, repo, title, metadata, folder
appling-pty-host kill <id>
appling-pty-host stop            # every session and the host
```

The status is `running`, `needs input` or `exited <code>`. The packaged app has no such command on your `PATH`; start the tray instead: `Appling --tray` (from a clone, `node packages/desktop/out/bin.js --tray`). It is a small Appling process without windows that lists the sessions with their status and can open the app at one, stop one or stop all. `Appling --session <id>` opens the app at a session directly.

## Agent sessions

An agent session is a coding agent running in a tab of the terminal panel, wired to the repo's Appling MCP tools. **Agents › New Agent Session…** (`Ctrl+Alt+A`, also the robot button of the panel) starts one from a preset: **Claude Code**, **Codex**, **Gemini CLI** or **opencode**. A repo can have as many sessions as you like, each in its own tab.

- **No setup.** Each session gets its own MCP session with a token. Desktop hands the agent the MCP server through its command line or environment and a configuration file in the session's own folder, and never edits your configuration files:

  | Agent | MCP server | Status |
  | :- | :- | :- |
  | Claude Code | `--mcp-config` (HTTP with an `Authorization` header) | HTTP hooks in `--settings`: PermissionRequest, Notification, Stop, StopFailure, UserPromptSubmit |
  | Codex | `-c mcp_servers.appling.url=…` with the token in `APPLING_MCP_TOKEN` | its TUI notifications as OSC 9 (`-c tui.notification_method="osc9"`) |
  | Gemini CLI | a system settings file of the session's own (`GEMINI_CLI_SYSTEM_SETTINGS_PATH`, merged over the machine's) | its BeforeAgent, AfterAgent and Notification hooks |
  | opencode | `OPENCODE_CONFIG_CONTENT` (a remote server with headers) | a plugin in `OPENCODE_CONFIG_DIR` for permission and idle events |

- **Status.** The tab shows the agent's name until the agent labels its session through MCP; double click the tab (or the name on the board) to rename it. Its colour follows the status: green while it works, amber while it needs input or is blocked, gray when it is done or exited, red when it failed. Label, status and claims come from the agent through MCP; that it waits for you or finished its turn comes from its hooks or terminal notifications, never from reading its output.
- **Exit.** When the agent exits, its tab turns gray and keeps its scrollback until you close it. Closing the tab ends the MCP session and releases its claims.
- **The rail** shows a dot per session under its repo, in its status colour, with a ring around the session whose tab is shown. The repo's badge sums its sessions.
- **The session board**, **Agents › Agent Sessions…** (`Ctrl+Shift+A`), lists every session of every workspace and repo with its label, status, repo, how long it runs and its unwatched playbook chapters. Arrows and Enter, or a click, jump to its tab.
- **Answer without the terminal.** When a session in a background repo or workspace needs input, a desktop notification says so. Click it, or the session's amber dot on the rail, for the answer form: **Allow**, **Deny**, an option number or a typed reply, written to the agent's terminal. On macOS the notification itself has Allow and Deny buttons and a reply field.
- **The canvas.** Elements a session claimed have a ring in the session's colour; click the ring to go to the session.
- **Restarts.** Sessions are terminals, so they keep running when the app closes and come back in their tabs, with their MCP session and token. The agents reach Desktop through one local endpoint whose port stays the same between starts.

Add your own presets, or change the built in ones, in `settings.json` of the app's data folder (**Terminal › Terminal Settings**):

```json
{
  "agents.presets": [
    { "name": "Aider", "command": "aider", "args": ["--mcp-server", "{mcpUrl}"], "env": { "AIDER_DARK_MODE": "1" } },
    { "name": "Claude Code", "command": "claude", "args": ["--model", "opus"], "wiring": "claude" }
  ]
}
```

`wiring` is `claude`, `codex`, `gemini`, `opencode` or `env` (the default): with `env` the agent gets `APPLING_MCP_URL`, `APPLING_MCP_TOKEN` and `APPLING_HOOK_URL`, the arguments may use `{mcpUrl}`, `{token}` and `{hookUrl}`, and any OSC 9 or OSC 777 notification marks it as waiting. `answers` sets the keys of `allow`, `deny`, `option` (`{n}` for the number) and `submit`.

> [!NOTE]
> Agent sessions run in local repos for now. An agent in a remote repo runs on that machine, which cannot reach the app's local MCP endpoint yet.

## Remote repos

A repo can live on another machine: on an SSH host, in a dev container or in WSL. Its IDE server, the pty host with its terminals and the code view then run there, next to the files, and Desktop shows them as it shows a local repo. A workspace can mix local and remote repos.

| Kind | Add it with | As a path |
|---|---|---|
| SSH host | **File › Add Remote Repository…**, which proposes the hosts of `~/.ssh/config` | `ssh://host/path`, `ssh://user@host:2222/~/src/shop` (`~` is the home folder there) |
| Dev container | **File › Open Folder in Dev Container…**, or **Reopen in Dev Container** in the menu of a repo with a `.devcontainer/devcontainer.json` | `devcontainer:///home/me/work/shop` (the folder on this machine) |
| WSL (Windows) | **File › Add Remote Repository…**, which proposes the installed distributions | `wsl://Ubuntu/home/me/shop` |

The paths work on the command line too:

```sh
./Appling-0.1.0-linux-x86_64.AppImage ssh://build/srv/shop ~/work/crm
```

- **SSH** logs in without asking: use a key, an ssh agent or a certificate, as for `ssh -o BatchMode=yes`. Everything in `~/.ssh/config` applies (aliases, `ProxyJump`, keys). An unknown host key is accepted on the first connection and checked afterwards. Everything goes through one ssh connection per repo.
- **Dev containers** start with the [devcontainer CLI](https://github.com/devcontainers/cli) when it is installed, so features and lifecycle commands run as in VS Code. Without it, Desktop runs the container itself with `docker`, from the `image` or `build.dockerfile` of devcontainer.json, mounts the folder at `workspaceFolder` (`/workspaces/<folder>` by default) and reuses the folder's container on the next start, also one that VS Code created. Docker Compose configurations need the CLI.
- **WSL** runs through `wsl.exe -d <distribution>`.

The first connection to a machine installs the Appling server into `~/.appling-server` there: the IDE server, the pty host and a Node binary for that machine, uploaded over the connection, so the machine needs no internet access. The code view adds Code OSS on first use; for remote repos it does not follow the canvas selection yet. Each Desktop build installs once per machine. The other machine must run Linux (glibc based, not Alpine) or macOS, on x64 or arm64. Terminals need node-pty for its platform; the Linux build of Desktop brings it for Linux x64.

The rail shows each remote repo's connection: a dashed amber border while it connects or reconnects, a dashed red one when it failed (the repo shows the reason with Retry), a small grey square when it is connected. The tooltip names the machine and, while reconnecting, the attempt. When the network drops, Desktop reconnects with growing pauses (1 s, doubling up to 30 s, ten attempts) and keeps the repo's view at the same address; the terminals keep running on the other machine and reattach. The branch and the changes in the rail come from `git status` on the other machine every 10 seconds.

In a `.code-workspace` file remote repos are written as VS Code writes them (`"uri": "vscode-remote://ssh-remote+build/srv/shop"`), so VS Code opens the same workspace.

## Tasks

Appling runs the tasks of VS Code's `.vscode/tasks.json`, so a repo set up for VS Code works as it is. **Tasks › Run Task…** lists the shown repo's tasks with their state: run, restart or stop one, or open its terminal. **Run Build Task** (`Ctrl+Shift+B`) runs the default build task.

- Each task runs in its own terminal of the repo's panel. It is running until it exits, then succeeded or failed by its exit code.
- `shell` and `process` tasks, `options.cwd` and `options.env`, the `windows`, `linux` and `osx` overrides, `dependsOn` with `dependsOrder`, inputs and variables such as `${workspaceFolder}` and `${env:HOME}` work as in VS Code. Tasks in the `tasks` section of a `.code-workspace` file count too.
- A background task (`isBackground`), such as a dev server or a watcher, stays running. It is ready once its problem matcher's end pattern shows up in its output; tasks that depend on it start then.
- Tasks with `"runOptions": { "runOn": "folderOpen" }` start when the repo opens. The first time, Appling asks whether automatic tasks may run in that folder and keeps the answer.
- Tasks keep running when you switch repos or close the app. At the next start Appling finds them again and knows their state.
- The built in tasks **appling: check**, **appling: generate** and **appling: release** run the [CLI](cli.md) over the repo; release asks for the version.
- In a [remote repo](#remote-repos) the tasks of its `tasks.json` run on that machine, in the repo's folder there.
- The rail shows the running and failed tasks of each repo, and the sums per workspace.

## Updates

Desktop looks for a new version on GitHub Releases at every start, and on **File › Check for Updates…**.

| Build | Update |
|---|---|
| Linux AppImage | Downloads in the background, then asks to restart. It replaces the AppImage file you started |
| Windows | Downloads in the background, then asks to restart; otherwise it installs when you quit |
| macOS, unsigned | macOS installs only signed updates, so Desktop shows the new version and opens its release page to download it by hand |
| macOS, signed | Like Windows |

An AppImage that was extracted or moved into a package keeps running but cannot replace itself; it points to the release page like an unsigned Mac build. Set `APPLING_DISABLE_UPDATES=1` to never look for updates, for example on managed machines. A copy started from the repository never updates.

## Inside the package

The app bundles everything it runs. Each repo's IDE server, the pty host that keeps terminals running, the language server, the [MCP server](ai.md#mcp-server) and the CLI of the built in tasks are Node programs that Desktop starts with its own Electron binary as Node (`ELECTRON_RUN_AS_NODE`), so no separate Node installation is needed. The terminal library node-pty is the only native module; it uses Node's stable ABI, so the same build loads in Electron.

## Build it yourself

```sh
pnpm install
pnpm --filter @appling/desktop... build
pnpm --filter @appling/desktop package --linux   # or --win, --mac
```

The installers land in `packages/desktop/release/`. Each system builds its own package, because node-pty is native. Pushing a tag `desktop-v<version>` runs the Desktop Release workflow, which builds all three on GitHub's runners and publishes them with the update manifests to a release of that tag. Signing and notarization start once the optional secrets that the workflow lists exist.

# @appling/desktop

Appling Desktop: one native app for many repos. Repos are grouped into workspaces, each repo gets its own Appling IDE server and a view that stays alive while you switch, with the model canvas, search and inspector as its main area.

In development (epic #15); the package is private until the first release. This is the shell with workspaces: the rail (collapsible, with pinned, reordered and hidden repos), one IDE server per repo, `.code-workspace` files, session restore, the fuzzy switcher, the app menu and rebindable shortcuts. Repos are added by folder, by cloning a git URL, or as remote repos on SSH hosts, in dev containers and in WSL. The rail shows each repo's agent sessions, validation errors, unsaved files and git state (branch, ahead and behind, dirty). Each repo's IDE has a Review tab with the model diff against any commit. Each repo has a code view, an embedded Code OSS. Workspaces, repos and panes move between windows on several monitors. It packages as an AppImage, an NSIS installer and a dmg, and updates itself from GitHub Releases. Each repo has its own terminals in a panel under its view. Task status in the rail follows.

To install a release, see [Desktop](https://appling.tools/docs/tools/desktop/) in the docs.

## Run it

```sh
pnpm build
node packages/desktop/out/bin.js [folders, remote repos or .code-workspace files...]
```

`appling-desktop [--session <terminal>] [--tray] [paths...]` opens each `.code-workspace` file as a workspace and adds each folder (default: the current folder) and each remote repo (`ssh://host/path`, `wsl://distro/path`, `devcontainer:///folder`, see [Remote repos](#remote-repos)) to the active workspace, in the running app or in a new one. A second call hands its paths to the running instance and returns. Electron downloads its binary on the first start. Exit code 2 when an argument is neither a folder, a remote repo nor a `.code-workspace` file.

The packaged app takes the same paths without `bin.js` (`Appling.AppImage ~/work/shop`, relative to the current folder). `--version` prints the version and quits before any window opens, so it runs without a display.

## Workspaces

A workspace (for example a client or a product) groups git repos. It is a VS Code multi root workspace file, `<name>.code-workspace`, so you can commit it, share it and open it in VS Code too.

- **File › New Workspace…** creates the file where you choose (by default in the app's user data folder, `workspaces/`). Choosing an existing file opens it instead, so it is never emptied.
- **File › Open Workspace…** opens existing files, also ones written by VS Code. Comments and trailing commas are read; relative folder paths resolve against the file's folder; a folder's `name` is shown instead of its folder name; remote folders (`uri` entries `vscode-remote://ssh-remote+host/path`, `wsl+distro`, `dev-container+<hex>`) open as remote repos and are written back the same way; other `uri` kinds are kept but not opened.
- **File › Add Folder to Workspace…** adds folders to the active workspace. Folders opened while no workspace is open go to `workspaces/Default.code-workspace` in the user data folder.
- **File › Clone Repository…** (also on the `+` below the repos) asks for a git URL (https, ssh or a path) and the folder to clone into, proposed next to the workspace's first repo (else `~/src` or the home folder). It runs `git clone --progress` and shows its progress; when it is done the new folder joins the active workspace. A failure shows git's own message and removes the half cloned folder; Escape or Cancel stops a running clone. Git never asks for a password here: use a credential helper or an ssh agent.
- Adding, closing or moving a repo writes the file back: folder paths relative to the file, every other key (`settings`, `extensions`, ...) kept. Comments in the file are lost on that write. A file that does not parse is never overwritten; the app reports it instead.
- Right click a repo in the rail to pin it to the top, hide it, move it to another open workspace, reveal it or close it; right click a workspace to show its hidden repos again, reveal its file or close it. Dropping a repo on another workspace's button moves it there too. A move writes both workspace files.

## Remote repos

A repo can live on another machine. Its IDE server (with the MCP server), the pty host (with the terminals and agent sessions) and its Code OSS run there, the way VS Code's remote server works; Desktop reaches them through a transport and forwards their ports and sockets to local ones, so the view, the code view and terminals behave as for a local repo.

| Repo id | Transport | How |
|---|---|---|
| `ssh://[user@]host[:port]/path` (`/~/x` for a path in the home folder) | `SshTransport` | One control master per repo (`ssh -M -S <socket>`, `BatchMode`, `ServerAliveInterval=10`); commands over it as `sh -c <script>`, ports as `ssh -W 127.0.0.1:<port>`, Unix sockets through the agent's `bridge` |
| `devcontainer:///local/folder` | `ContainerTransport` | `devcontainer up` when the CLI runs, else `docker run` of devcontainer.json's `image` or `build.dockerfile` with the folder mounted at `workspaceFolder`, labelled `devcontainer.local_folder` (VS Code's label, so its containers are reused); commands as `docker exec -i [-u remoteUser]`, streams through the agent's `bridge`; `docker wait` reports a stopped container as a lost connection |
| `wsl://distro/path` | `WslTransport` | `wsl.exe -d <distro> --exec sh -c <script>`, streams through the agent's `bridge` (only unit tested) |
| an absolute path | `LocalTransport` | `sh -c` and direct connections (tests; local repos keep the direct child process) |

**File › Add Remote Repository…** (`addRemote`) opens a form with one field that proposes the hosts of `~/.ssh/config` (`Include` followed, wildcard patterns skipped) and on Windows the WSL distributions; **File › Open Folder in Dev Container…** (`openInContainer`) and the repo menu's **Reopen in Dev Container** add a folder's dev container. SSH logs in without prompts (keys, agent or certificate); an unknown host key is accepted on first use (`StrictHostKeyChecking=accept-new`).

- **Install.** The first connection runs a probe (`uname -sm`, home folder, libc, what is installed) and uploads what is missing as `.tar.gz` streams over the transport into `${APPLING_SERVER_ROOT:-~/.appling-server}`: the server bundle per version (`<root>/<app version>-<digest>/`: the IDE server with its client, the pty host with node-pty, `remote/agent.js` and the Appling extension), a Node binary per Node version and platform (`<root>/node/v<version>-<platform>-<arch>/`, downloaded here from nodejs.org and checked against its `SHASUMS256.txt`), and Code OSS when the code view first opens (`<root>/code/`, the pinned openvscode-server of `code-download.ts`). Each part is unpacked into a temporary folder and moved into place, so a broken upload leaves nothing. The machine needs no internet access. Linux with glibc or macOS on x64 or arm64; terminals need node-pty for the platform (the bundle carries this machine's build and the npm prebuilds).
- **The agent** (`src/remote/agent.ts`, bundled to `remote/agent.js`) is the remote side: `ide` runs the IDE server with an IPC channel and relays it as JSON lines over stdio (ready, status, the shared agent sessions), `bridge` pipes stdio to a port or socket, `pty-host` starts the pty host (it keeps running when Desktop goes) and prints its socket and token, `code` runs openvscode-server.
- **Forwarding.** The IDE server's port is served on a local port that stays the same across reconnects; the server trusts that origin through `--origin`. The pty host's socket is served in a local folder per repo with its token, so `connectPtyHost({ dir, start: false })` reaches the remote host as a local one. Code OSS is forwarded to a local port behind the code proxy (no selection sync for remote repos yet).
- **Reconnects** (`connection.ts`): `connecting → connected → reconnecting → connected`, `failed` when the first connect fails or ten attempts after a drop (1 s doubling up to 30 s, with jitter) fail; Retry starts over. A dead ssh master, a stopped container or the end of the IDE server's relay count as a drop. After a reconnect the view reloads at the same URL and terminals reattach with their scrollback.
- **The rail** gets the `connection` source (`remote/rail.ts`): its state marks the button (dashed amber while connecting or reconnecting, dashed red when failed, a grey square when connected) and its tooltip line names the machine, the attempt and the reason. The `git` source reads `git status --porcelain=v2 --branch` over the transport every 10 seconds.

## The rail

The rail is 48px wide: workspaces on top, the repos of the active workspace below. **View › Toggle Rail** (`CmdOrCtrl+B`) folds it away so the repo view takes the whole window.

- **Pinned** repos (a green dot) stay at the top of the rail, in their workspace's folder order.
- **Hidden** repos leave the rail and `CmdOrCtrl+1..9`, which count the rail's repos. They keep their server and view, and the switcher still finds them; a hidden repo you switch to shows on the rail with a dotted border while it is shown. Pinning a hidden repo shows it again.
- **Status**: each repo's button carries a badge with its most urgent count, and its tooltip lists them all; a workspace's button shows the sums over all its repos, hidden ones included. In order of urgency:

  | Count | Badge |
  |---|---|
  | Agent sessions that need input or are blocked | amber |
  | Agent sessions that failed, tasks that failed | red |
  | Validation errors of the model (after every saved change of a `.appling` file) | red |
  | Agent sessions working, tasks running (the button is also ringed green) | green |
  | Files with unsaved edits in the repo's view (named in the tooltip) | grey |
  | Playbook chapters of the repo not yet watched to their last step | blue |

  Unseen model changes, the changed files the repo's IDE marks live until you accept them in its Changes tab, are counted in the tooltip and put a green dot in the top right corner of a background repo (and of a workspace other than the active one) instead of a badge.

- The **git state**: the branch (a short commit while the head is detached), the commits ahead of and behind its upstream and the number of changed files are in the repo's tooltip. A dot in the top left corner marks uncommitted changes, and `↑2↓1` in the bottom left corner the ahead and behind counts. It follows commits, checkouts, fetches and edits made anywhere, also in a terminal outside the app: the git folder is watched and `git status` runs every 5 seconds. Worktrees and submodules (a `.git` file) work too.
- **Drag** a repo onto another to place it before that one; it joins the group (pinned or not) of the repo it lands on. Drop it on the `+` below the repos to move it to the end. The new order is written to the workspace file's `folders`, so VS Code shows it too.

Pins, hidden repos and the collapsed rail are part of the session, not of the workspace file.

## Switcher

**Repo › Go to Repo…** (`CmdOrCtrl+P`) opens a fuzzy switcher over every repo of every open workspace, hidden ones included. Type a few letters of the name (they match in order, word starts and runs count most; a query may also start with the workspace name), use the arrows and Enter to go, Escape to leave. Without a query it lists the repos in most recently used order with the shown one last, so `CmdOrCtrl+P` then Enter goes back to the previous repo. A repo in two workspaces gets a line per workspace. While the switcher is open the repo views are hidden behind the shell page that draws it.

Several workspaces stay open at once. A folder may sit in more than one workspace; it is still one repo with one server and one view. A repo's server runs while any open workspace holds it, so switching repos or workspaces never reloads a view.

The open workspaces, the repo shown in each, the active workspace, the most recently used order, the pinned and hidden repos, whether the rail is collapsed and the window layouts (see [Windows](#windows)) are saved to `session.json` in the user data folder on every change and restored at the next start. Workspace files are read again then, so changes made in VS Code meanwhile show up; a file that is gone or broken is reported and left out.

## Windows

Every window has the rail and the switcher. The first window is the main window: it holds every workspace that no other window holds, and closing it quits the app.

- **Detach** a workspace or a repo by dragging it out of the rail and dropping it outside every window: it opens in a new window there. Right click › **Move to New Window** does the same, and **Window › Move Repo to New Window** (`CmdOrCtrl+Shift+D`) or **Move Workspace to New Window** do it for the shown one.
- A detached **workspace** takes its repos along: the new window's rail shows it, the main window's rail no longer does. A detached **repo** moves its canvas: the new window shows it as a column of its own, listed below a line at the bottom of the rail, and the repo's button in its workspace's rail turns dashed. Selecting it there shows where it is, with **Go There** and **Dock Here**.
- **Panes** of a repo other than its canvas (the code view, the terminal panel) move on their own: right click the repo › **Move Code** › **Move to New Window** or **Move to Window**. A closed code view keeps its view alive and leaves its place to the canvas.
- **Move** an item into another window by dropping it on that window (its rail or its panes), or through right click › **Move to Window**. A repo dropped on a window that holds one of its workspaces docks back into its column there; elsewhere it gets a column of its own, next to whatever that window shows.
- **Dock back**: right click a moved pane › **Dock Back** (or the repo › **Dock Back from Window n**), drag a workspace back onto the main window, or close the window: **Window › Dock Window** or the window's close button gives every workspace back to the main window and every pane back to its repo. A window left empty closes.
- **Nothing reloads.** Every pane is one kept alive view; moving it between windows moves that view, so the canvas, its selection, the source view, agent sessions and terminals stay exactly as they were.
- Shortcuts act in the focused window. Selecting a repo or workspace that lives in another window (with the switcher, `Ctrl+Tab` or `CmdOrCtrl+Alt+1..9`) brings that window to the front.
- **Layouts per monitor setup.** Which window holds what, and every window's bounds, display and maximized state, are saved in `session.json` per monitor setup (keyed by the ids and bounds of every display) and restored at the next start; up to 8 setups are kept. A setup never seen before takes the newest layout. A window whose display is gone opens on the primary display, at the same offset into its work area and no larger than it. Plugging a monitor in or out while the app runs moves the windows to the bounds saved for the new setup, or off a display that is gone.

## Code view

**View › Toggle Code View** (`CmdOrCtrl+Alt+C`) opens the repo's code view on the right of the canvas: a full Code OSS ([openvscode-server](https://github.com/gitpod-io/openvscode-server)) with explorer, editor, search, source control and extensions, opened on the repo's folder. It is hidden by default; toggling it off again lets the canvas fill the repo. Each repo has its own instance, which survives switching repos and workspaces.

- **Download.** The first open downloads the pinned openvscode-server (`CODE_SERVER` in `code-download.ts`, about 75 MB) into `code-oss/server/` in the user data folder, checks its SHA-256 against the pinned digest and unpacks it; nothing partial stays in the cache. openvscode-server publishes Linux builds only (x64, arm64, armhf), so on macOS and Windows the code view reports that it is not available. `APPLING_CODE_SERVER=<path to bin/openvscode-server>` uses another server instead.
- **Extensions** install from Open VSX, the gallery openvscode-server uses, into `code-oss/extensions/`, shared by every repo; their workspace state stays per repo. The Appling extension (`appling-vscode`, built with `packages/vscode`) is installed on the first start and again whenever its build changes, so `.appling` files have the language server. `APPLING_VSIX` points at another `.vsix`.
- **Settings and keybindings** are shared across repos. Code OSS keeps them, with the UI state, in the browser storage of its origin, so every instance is served from one local proxy origin (`http://127.0.0.1:<port>/r/<repo key>/`) on a port kept in `code-oss/proxy.json`. Each repo's tabs and layout are stored per folder and come back after a restart or a suspend.
- **Lifecycle**, in `settings.json` in the user data folder:

  ```json
  { "codeView": { "lifecycle": "lazy", "idleMinutes": 15, "width": 0.5 } }
  ```

  `lazy` (the default) starts an instance the first time its code view opens and stops its process after the code view was out of sight (hidden, or its repo not shown) for `idleMinutes`; it starts again, with its tabs, when the code view shows again. `always` starts the instance with the repo and keeps it running while the repo is open. `width` is the code view's share of the repo (0.2 to 0.8). Bad values are skipped and reported on stderr.
- **Selection sync.** Selecting an element on the canvas, in the search or in the inspector opens its source in the code view. Moving the cursor in a `.appling` file in the code view selects the element there on the canvas. The Appling extension talks to the main process over a websocket on the proxy (`/bridge`), with a token per instance start.
- **Text diffs.** **text diff** in the IDE's Review tab opens Code OSS's diff editor in the code view (opening and starting it when needed): the file at the chosen commit, through the built in git extension's `git:` URIs, against the working tree, at the element's line. A deleted file opens at the commit alone. Where there is no code view (macOS, Windows) the Review tab shows the diff itself.
- **Open in VS Code.** **Repo › Open File in VS Code** opens the file last in focus (in the code view or selected on the canvas) at its line in VS Code; **Repo › Open Repo in VS Code** and the rail's context menu open the repo. They use the `code` command from the PATH (on macOS also from the app bundle).

Each instance listens on its own port on 127.0.0.1 and requires its own connection token, which only the proxy knows; the proxy admits only the code views, by a cookie with a secret of the running app.

## Terminals

Every repo has a terminal panel under its view: **Terminal › Toggle Terminal Panel** (`` Ctrl+` ``) opens it (with a first terminal) and closes it again, **New Terminal** (`` Ctrl+Shift+` ``) adds a tab, **Split Terminal** (`CmdOrCtrl+Shift+5`) puts a terminal next to the focused one. Drag the panel's top edge to resize it. The panel is a `terminal` pane: right click the repo › **Move Terminal** puts it into a window of its own or another window, like the code view. Terminals belong to their repo and keep running, attached, while another repo or workspace is shown.

- **The terminal** is xterm.js with the WebGL renderer (the DOM renderer where WebGL is missing), unicode 11 widths, true colour, mouse, bracketed paste, sixel and iTerm (OSC 1337) images, OSC 52 clipboard writes (programs cannot read the clipboard), OSC 8 hyperlinks and search (`CmdOrCtrl+Shift+F`, Cmd+F on macOS). Copy and paste are `Ctrl+Shift+C` and `Ctrl+Shift+V` (Cmd+C and Cmd+V on macOS). `TERM=xterm-256color`, `COLORTERM=truecolor` and `TERM_PROGRAM=Appling` are set.
- **Keys** belong to the program: the app menu's shortcuts are off inside a terminal, so `Ctrl+R`, `Ctrl+W`, `Ctrl+B` and `Ctrl+P` reach the shell, tmux or vim. Only `nextRepo`, `previousRepo`, `nextWorkspace`, `previousWorkspace`, `workspace1..9`, `devTools` and the terminal commands with a shortcut pass through, by their current bindings.
- **Links** open on Ctrl+click (Cmd+click on macOS): URLs in the browser; file paths a program prints (`src/app.ts:12:5`, `./notes.md`, `/etc/hosts`, `"app.py", line 3`), resolved against the terminal's working directory and shown as links only when they exist, through a file opener that the code view will take over; until then the OS opens them.
- **Tabs** show the name (the profile's or the program's; double click to rename) and, while the shell runs a command, that command. The dot says how the last command ended (green, red, grey while running, yellow for a bell or a notification you have not seen). Drag tabs to reorder them, middle click or × to kill one, right click for split, clear, find, interrupt and kill.
- **Profiles** come from `$SHELL`, the shells in `/etc/shells` (Windows: PowerShell, the Command Prompt and Git Bash) and VS Code's `terminal.integrated.profiles.<linux|osx|windows>` settings (VS Code's user settings, then the `settings` of the workspace files holding the repo, then the repo's `.vscode/settings.json`, then Appling's own settings): `path` (a string or a list, the first that exists; bare names are looked up on `PATH`), `args`, `env` (`null` removes a variable), `icon`, `color` and `source` (Windows); `null` removes a profile. `${env:NAME}`, `${userHome}`, `${workspaceFolder}` and `${pathSeparator}` are replaced. The default is `terminal.defaultProfile`, then VS Code's `terminal.integrated.defaultProfile.<os>`, then the shell of `$SHELL`. The ▾ button starts a terminal with another profile.
- **Shell integration** for bash, zsh and fish works the way VS Code's does: the shell starts with a script (bash `--init-file`, zsh a `ZDOTDIR` whose files read yours first, fish `--init-command`) that reads your own startup files and then marks every prompt and command with OSC 633 sequences. The app records each command line, its exit status and the working directory (also from OSC 7). `Ctrl+Up` and `Ctrl+Down` (Cmd on macOS) jump between commands, and the overview ruler shows each command green or red. Shells started with other arguments (`-c`, a script) and other shells run as they are.
- **Terminals survive the app.** They run in the pty host (`@appling/pty-host`), so closing the app, or a crash, leaves them running; at the next start they reattach with their screen and scrollback, in their tabs and splits (`terminals.json` in the user data folder). A shell that exits cleanly closes its tab; one that fails, and a program started with a command, keep theirs to be read. Closing a repo ends its terminals.
- **End terminals with the app** (a checkbox in the Terminal menu, or `"terminal.endWithApp": true` in `settings.json`) ends every terminal when the app quits instead, agent sessions (started through `createSession`) included; after a crash the leftovers are ended at the next start.
- **While the app is closed** the pty host keeps each terminal's status (running, needs input after an OSC 9 or OSC 777 notification until the next input, exited with its code) and raises a desktop notification for a terminal that needs input while nobody is attached to it. The app starts the host with `open: openCommand(appLaunch())` (`src/app-flags.ts`), so a click runs `Appling --session <id>` (`electron out/main.js --session <id>` in development; `$APPIMAGE` for an AppImage, whose own path goes away with it). `--session` (also through the single instance lock's `second-instance`) adds the terminal's repo when no workspace holds it, selects it and opens its panel at the tab (`TerminalPanel.reveal`). A reply from the notification is written to the pty by the host itself.
- **Remote repos**: the remote pty host starts with `notify: false` (`remote/agent.ts`). While the repo is connected, `RemoteStatus` (`remote/notify.ts`) subscribes to that host through the repo's forwarded folder (`RemoteRepos.ptyDir`) and raises the notification on this machine for a terminal that needs input with nothing attached, also for one that was already waiting at connect. A reply goes to the remote pty; a click shows the repo.
- **Tray only mode** (`--tray`, `src/tray.ts`, entries in `src/tray-menu.ts`): a tray needs a running Electron, and the app's own process holds windows, the IDE servers and the single instance lock, so the tray is the same executable in a mode of its own instead: its own user data folder (`Appling Tray`) and lock, no windows, no terminals of its own. It subscribes to the pty host (without starting one; it looks again every 5 seconds), lists the sessions with their status (waiting ones first) and opens the app at one (`--session`), stops one or stops all. Nothing starts it automatically; add `Appling --tray` to the desktop's autostart to keep it around.

`settings.json` in the user data folder (**Terminal › Terminal Settings** opens it) holds `terminal.endWithApp`, `terminal.defaultProfile`, `terminal.shellIntegration` (default `true`), `terminal.scrollback` (10000), `terminal.fontSize` (13), `terminal.fontFamily` and `terminal.cursorBlink`. Where one is unset, VS Code's `terminal.integrated.*` counterpart applies. Font changes apply to open terminals right away, the rest to new ones.

### For agent sessions

`TerminalService` (`src/terminal/service.ts`, Electron free) is the API the agent sessions build on: `createSession(repo, { name, command, args, env, cwd, meta })` starts a named terminal running a command with extra environment in the repo's panel and returns a `TerminalSession` with `onNotification` (OSC 9 and OSC 777 `notify`, the earlier ones first), `onEvent` (commands, working directory, OSC 9;4 progress), `onExit` (the exit status), `onData`, `write` and `kill`. `meta` (string values, such as the agent preset and a `label`) is kept and listed by the pty host, also while the app is closed, and comes back in the terminal's state; the host titles its notifications with `label`, and `notify: 'off'` silences them for the terminal. `TerminalPanel.fileOpener` is the hook for the code view.

## Tasks

The **Tasks** menu runs the tasks of VS Code's `.vscode/tasks.json` (version 2) in the shown repo, so an existing VS Code repo works as it is. **Run Task…** opens the task list over the window: every task with its state, **Run**, **Restart**, **Stop** and **Terminal**; type to filter, Enter runs the selected task or shows the terminal of a running one. **Run Build Task** (`CmdOrCtrl+Shift+B`) runs the default build task (`"group": { "kind": "build", "isDefault": true }`). Below them the menu lists every task with its state and the same actions, then **Allow Automatic Tasks in Folder** and **Configure Tasks…** (opens `tasks.json`, writing an empty one first).

- **Each task runs in its own terminal** of the repo's panel, named `Task - <label>`; a new run replaces the terminal of the last one. A task's state is *running*, then *succeeded* or *failed* by the exit code, or *stopped* when you stopped it (SIGTERM, SIGKILL after 3 seconds; the terminal stays with its output). A task waits for its dependencies first.
- **What is read**: the `shell` type (one command line through `options.shell`, else `$SHELL -c`, `cmd.exe /d /c` on Windows, with the arguments quoted as VS Code does, including `{ "value", "quoting": "escape" | "strong" | "weak" }`), the `process` type (the program with its arguments), `npm` tasks with a `script` (as `npm run <script>`), `command`, `args`, `options.cwd`, `options.env` and `options.shell`, the `windows`, `linux` and `osx` overrides, the file's global properties (`command`, `options`, ... and their platform sections), `dependsOn` with `dependsOrder` (`parallel`, the default, or `sequence`; a task several others depend on runs once; a failed dependency keeps its dependents from running; a task with only `dependsOn` runs just those), `isBackground`, `runOptions.runOn: "folderOpen"`, `group`, `detail`, `hide` and `presentation.reveal` (`always` shows the task's terminal, `silent` only when it fails, `never`) and `presentation.close`. Tasks of other types (gulp, extensions' types) are skipped. The tasks of the `tasks` section of every `.code-workspace` file holding the repo come next, then the built in ones; a label that is taken already is skipped.
- **Variables**: `${workspaceFolder}` (the repo), `${workspaceFolderBasename}`, `${workspaceFolder:<name>}` (a folder of the repo's workspaces), `${env:NAME}`, `${userHome}`, `${pathSeparator}` and `${/}`, `${config:<key>}` and `${input:<id>}` of `promptString` and `pickString` inputs, which the task list asks for before the run. Variables of an editor (`${file}`, ...) are empty.
- **Background tasks** (`isBackground`) stay *running*. While running they are *starting* until their problem matcher's `background.endsPattern` matches a line of output (escape sequences removed), and busy again when its `beginsPattern` matches; dependents start once it is ready. Matchers are objects with `background` (or `watching`), or the names `$tsc-watch` and `$esbuild-watch`; a background task without such patterns counts as ready once it started, as in VS Code.
- **Tasks survive switching repos and closing the app.** Their terminals live in the pty host; `task-states.json` in the user data folder keeps each task's state and terminal. At the next start the tasks find their terminals again: a task that ended meanwhile gets its exit code, a background task its readiness from the terminal's screen and scrollback. Closing a repo ends its tasks.
- **Automatic tasks** (`"runOptions": { "runOn": "folderOpen" }`) start when the repo opens, unless they run already. The first time a folder has them the app asks, as VS Code does, whether automatic tasks may run there; the answer is kept per folder and the Tasks menu's checkbox changes it.
- **Built in tasks**: `appling: check`, `appling: generate` and `appling: release` (which asks for the version) run the repo's own `node_modules/.bin/appling` when it has one, else the CLI that ships with the app. A task of `tasks.json` with the same label takes their place.
- **The rail** counts the running tasks (background ones included) and the failed ones per repo, summed per workspace, and names them in the tooltip (`Task running: dev (ready)`, `Task failed: build, exited with code 1`).

## How it works

- `bin.ts` resolves the paths and starts Electron detached with `main.js -- <paths>`. The main process takes Electron's single instance lock with the paths as additional data; a second instance hands them to the first through `second-instance` and quits.
- `workspaces.ts` holds the pure state (open workspaces, the shown repo per workspace, pins and hidden repos, the rail order, the collapsed rail, the most recently used order); `switcher.ts` ranks the switcher's lines (`fuzzyMatch`, `switcherEntries`); `code-workspace.ts` reads and writes the files; `session.ts` saves and restores the session; `repos.ts` tracks the repos that have a server; `git.ts` reads the branch from `HEAD` without running git and the full state with `git status --porcelain=v2 --branch` (`parseGitStatus`, `readGitState`); `watchGit` follows it for the main process; `clone.ts` runs `git clone` with progress (`clone-ipc.ts` connects it to the shell's form).
- `rail-status.ts` is the rail's status model. Each feature reports through its own source, `rail.source('name').set(repo, { counts, branch, notes })` (or `replace` for every repo at once, `clear`), so no feature overwrites another's numbers; `repo(id)` sums the sources and `sum(repos)` a workspace. Sources today: `validation` (the server's error count), `editor` (unsaved files), `git` (branch, ahead, behind and dirty from `watchGit`), `agents` (the agent sessions store, through `agentContributions`), `live` (unseen model changes), `playbook` (unwatched playbook chapters, through `playbookContributions`) and `tasks` (the task states, through `taskContributions`). A new count is a key of `RailCounts` and a place in `RAIL_COUNTS`, which orders them by urgency for the badge.
- Every repo runs `appling-ide <folder> --port 0` in its own child process (Electron's binary with `ELECTRON_RUN_AS_NODE`), so a failing repo cannot take the app down. The server reports its URL over the IPC channel, then `{ type: 'status', errors }` at start and after every model change and `{ type: 'status', unsaved }` (repo relative paths) whenever the files with unsaved edits change; the IDE client sends those to its server over `/events` (`{ type: 'unsaved', files }`). It ends when the channel closes, also when the app is killed. A server that ends shows its error with Retry and Close.
- Each window holds the shell page (`src/shell`: the 48px rail with workspaces on top and the repos of the active workspace below, and the empty and error states) and one `WebContentsView` per repo loading `<ide url>/?shell=desktop`: the IDE client with the canvas as the main area, the source folded away behind **Source** and no AI chat. Views of inactive repos are hidden, not destroyed. A view may navigate only within its own server; `https` links open in the browser.
- `remote/`: remote repos. `location.ts` (repo ids and VS Code's `vscode-remote` URIs), `ssh-config.ts`, `devcontainer.ts` (reading devcontainer.json and the `docker` plan) and `container.ts`, `transport.ts` (the `Transport` interface and its ssh, container, WSL and local implementations), `install.ts` (probe, plan, upload), `forward.ts` (local ports and sockets whose connections open streams over the transport), `relay.ts` (the IDE server's IPC channel over stdio, as a child process for `startIdeProcess({ launch })`), `connection.ts` (the reconnect state machine), `remote-repo.ts` (one remote repo), `desktop.ts` (every remote repo of the app, with the rail sources) and `remote-ipc.ts` (the form). Repo ids are absolute paths or these URIs everywhere (`repoId` normalizes both).
- `agent-sessions.ts`: the main process holds one store of agent sessions for every workspace and serves it to each repo's server over its IPC channel (`--shared-sessions`), with `desktopHost` adding the active repo, the workspace and the focus action to the sessions' IDE context. Agents reach the repo server's `/mcp` with their session's token (`openAgentSession`).
- `playbooks.ts`: the main process also holds the workspace playbooks (`desktopPlaybooks`, a `MemoryPlaybookStore` kept as one JSON file per workspace in `playbooks/` of the user data folder), served to each repo's server over the same IPC channel, so the sessions of all repos of a workspace write one playbook and it outlives them. `playbookRail` feeds the unwatched chapters of the open workspaces into the rail's `playbook` source (`playbookContributions`).
- `windows.ts` holds the windows as pure state (`Windows`: which window holds which workspace, the panes moved into each, the shown workspace per window, the focus order, `placement` of every pane, `dropTarget` of a drag that left the rail, `rememberLayout` and `layoutFor` per monitor setup); `displays.ts` the display fingerprint and the fallback placement (`placeWindow`); `panes.ts` the pane ids, types and the column layout (`layoutPanes`). `window-host.ts` is the thin Electron side: one `BaseWindow` per window with its shell page as a `WebContentsView`, the pane views moved with `contentView.removeChildView` and `addChildView`.
- The shell talks to the main process only through the preload bridge (`preload.cts`); every page runs sandboxed with context isolation. A repo view's own preload (`repo-preload.cts`) exposes `window.applingDesktop` for the code view's selection sync and `openTextDiff` (only where the code view runs).
- The code view: `code-download.ts` (pinned release, verified download), `code-server.ts` (one openvscode-server per repo: `--host 127.0.0.1 --port 0 --connection-token-file --server-base-path /r/<key>` with the shared `--user-data-dir`, `--extensions-dir` and `--server-data-dir`), `code-instances.ts` (the pure lifecycle: lazy start, idle suspend, always alive), `code-proxy.ts` (the one origin proxy, which swaps the cookie for each instance's token), `code-bridge.ts` (the extension channel), `code-settings.ts`, `vscode-cli.ts` and the Electron glue in `code-view.ts` (one kept alive `WebContentsView` per repo in the `persist:appling-code` session).

- `terminal/` holds the terminals: `profiles.ts`, `settings.ts`, `shell-integration.ts` (injection, the OSC scanner and the command records; the scripts in `terminal/scripts/`), `registry.ts` (tabs, splits and panel state per repo), `links.ts`, `keys.ts` (the shortcuts that pass through terminals) and `service.ts` are pure or Electron free and tested, partly against a real pty host. `panel.ts` is the Electron glue: one kept alive `WebContentsView` per repo with the terminal page (`terminal/view`, bundled with esbuild by `build-terminal.mjs`, with its own preload), registered as the `terminal` pane; the main process keeps one pty host attachment per terminal and streams its snapshot and output to the page.
- `tasks/` holds the tasks: `definitions.ts` reads `tasks.json` and the workspace files' `tasks` (platform overrides, global properties, problem matchers' background patterns), `variables.ts` resolves the variables and builds the launch of a shell or process task, `plan.ts` orders the dependencies (`dependencyPlan`, `executePlan`), `state.ts` is the state machine of a task, the `BackgroundMatcher`, the rail contributions and the stored states, `builtin.ts` the `appling` tasks. `runner.ts` (`TaskRunner`, Electron free, tested against a real pty host) runs them on the `TerminalService`, follows each terminal's output and exit, keeps the states and reattaches after a restart. `ipc.ts` is the Electron glue (the Tasks menu, the automatic tasks question, the task list that `shell/tasks.ts` draws).

## Packaging

```sh
pnpm --filter @appling/desktop... build
pnpm --filter @appling/desktop package --linux   # or --win, --mac; more electron-builder flags pass through
```

`package` runs two steps. `scripts/bundle.mjs` writes `app/`: Desktop's main process (`out/main.js`, electron-updater and the parts of `@appling/ai` it uses included, with the AI skills and language pages in `skills/` and `language/` beside `out/`, both preloads and the shell page) and each program Desktop runs, bundled by esbuild into one ESM file at the path of `BUNDLED` in `src/resources.ts`, next to the files its package reads at runtime:

| Program | In `app/` | Brings along |
|---|---|---|
| IDE server (`appling-ide`) | `ide/out/server/main.js` | `ide/dist/client/`, the AI skills and language pages in `ide/out/` |
| pty host (`appling-pty-host`) | `pty-host/out/main.js` | `pty-host/package.json` (its version) |
| language server (`appling-language-server`) | `lang/out/language-server.js` | |
| MCP server (`appling-mcp`) | `ai/out/main.js` | `ai/skills/`, `ai/language/` |
| command line (`appling`), for the built in tasks | `cli/out/main.js` | |
| Appling extension for the code view (`appling-vscode`) | `vscode/appling.vsix`, outside the asar archive | |

node-pty is native and not bundled: its JavaScript and this platform's native files (a local build on Linux, the prebuilds on Windows and macOS) are copied to `native/node-pty`, outside the asar archive. It is N-API, so the Node build loads in Electron without a rebuild. `APPLING_DESKTOP_VERSION` sets the app's version, else this package's is used; `--out <folder>` writes elsewhere. Then electron-builder (`electron-builder.config.mjs`) packs `app/` into `release/`: `Appling-<version>-linux-x86_64.AppImage`, `Appling-Setup-<version>-x64.exe`, `Appling-<version>-mac-{arm64,x64}.{dmg,zip}` and the `latest*.yml` update manifests. It installs and collects no `node_modules`; `app/` is complete.

`programPath(program)` (`src/resources.ts`) finds each program at run time: the bundled copy in the app's root (the folder above the bundled `out/main.js`) when it exists, else the built entry of the workspace package. For files that a program outside Electron reads (`UNPACKED`: the vsix, which openvscode-server installs) it returns the path in `app.asar.unpacked`. `startIdeProcess`, the code view and the pty host's `startPtyHost({ main })` take the result, and every program runs with Electron's binary as Node (`ELECTRON_RUN_AS_NODE`).

## Updates

`src/updater.ts` uses electron-updater with the GitHub provider: a quiet check at start and **File › Check for Updates…** (`checkForUpdates`, no default shortcut). `updateMode` in `src/update-policy.ts` decides how:

| Mode | When | Does |
|---|---|---|
| `auto` | Windows; Linux started from its AppImage (`APPIMAGE` is set); macOS when signed | Downloads, then asks to restart (or installs on quit) |
| `manual` | macOS unsigned (macOS installs only signed updates); Linux not run from the AppImage | Reports the new version and opens its release page |
| `none` | Not packaged, or `APPLING_DISABLE_UPDATES` set (not `0`) | Does not look; the menu item says why |

Whether a build is signed comes from `signed` in the packaged `package.json`, which the builder config sets when the signing secrets are present. electron-updater asks for the repository's latest release, so stable Desktop releases are marked latest.

## Releases

Pushing a tag `desktop-v<version>` runs `.github/workflows/desktop-release.yml`: an ubuntu, windows and macos matrix builds, bundles and packages with that version (the Linux job also extracts the AppImage and checks `--version`), then one job publishes every file to a GitHub Release of the tag (a prerelease for versions with a `-` suffix). Builds are unsigned until these optional secrets exist:

| Secrets | For |
|---|---|
| `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD` | macOS signing with a Developer ID Application certificate (base64 `.p12`) |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | macOS notarization, with signing |
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | Windows signing with a certificate (base64 `.pfx`) |
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT`, `AZURE_SIGNING_PROFILE`, `AZURE_PUBLISHER_NAME` | Windows signing with Azure Trusted Signing instead |

## Adding a pane type

A pane is one `WebContentsView` of a repo that can live in any window. The repo view (type `ide`, labeled Canvas) and the code view (type `code`, a `side` strip whose share is `codeView.width`; `code-view.ts` hands its views over through `attach` and `detach`) are panes; the terminal (#9) and agent sessions plug in the same way:

1. Register the type once: `registerPaneType({ type: 'terminal', label: 'Terminal', region: 'bottom' })`. The region places it in the window that shows its repo: `main` fills the repo's column, `bottom` panes share a strip below it, `side` panes a strip on its right. A pane moved into another window always gets a column of its own there.
2. Create its view and hand it over: `host.addPane(paneId('terminal', repo, key), view)`, then `refresh()`. The key tells several panes of one type and repo apart. Do not add the view to a window yourself; `host.arrange()` puts it into its window, sizes it and shows or hides it.
3. When it ends, `host.removePane(id)?.webContents.close()`. Panes of a repo whose server stopped are forgotten by the windows; a moved pane whose view is not there yet (restored before it started) keeps its window.

Moving, docking, the rail entry of a moved pane and saving it in the layout work for every type without more code.

## Shortcuts

| Command | Default |
|---|---|
| `newWorkspace`, `openWorkspace` | `CmdOrCtrl+Shift+N`, `CmdOrCtrl+Shift+O` |
| `open` (Add Folder to Workspace…) | `CmdOrCtrl+O` |
| `clone` (Clone Repository…) | none |
| `addRemote` (Add Remote Repository…), `openInContainer` (Open Folder in Dev Container…) | none |
| `closeRepo` (removes it from the active workspace) | `CmdOrCtrl+W` |
| `switcher` (Go to Repo…) | `CmdOrCtrl+P` |
| `closeWorkspace` | `CmdOrCtrl+Shift+W` |
| `nextRepo`, `previousRepo` (most recently used order, across workspaces) | `Ctrl+Tab`, `Ctrl+Shift+Tab` |
| `repo1` … `repo9` (the rail's repos of the active workspace) | `CmdOrCtrl+1` … `CmdOrCtrl+9` |
| `nextWorkspace`, `previousWorkspace` | `CmdOrCtrl+PageDown`, `CmdOrCtrl+PageUp` |
| `workspace1` … `workspace9` | `CmdOrCtrl+Alt+1` … `CmdOrCtrl+Alt+9` |
| `detachRepo` (moves the shown repo's canvas to a new window) | `CmdOrCtrl+Shift+D` |
| `detachWorkspace`, `dockWindow` (closes the focused window, everything in it goes back) | none |
| `toggleRail` | `CmdOrCtrl+B` |
| `toggleSource` | `CmdOrCtrl+E` |
| `toggleCode` (the code view) | `CmdOrCtrl+Alt+C` |
| `openFileInVSCode`, `openRepoInVSCode` | none |
| `reload` (the active repo's view) | `CmdOrCtrl+R` |
| `devTools` | `CmdOrCtrl+Alt+I` |
| `keybindings` (opens the keybindings file) | `CmdOrCtrl+K` |
| `checkForUpdates` | none |
| `quit` | `CmdOrCtrl+Q` |
| `toggleTerminal`, `newTerminal` | `` Ctrl+` ``, `` Ctrl+Shift+` `` |
| `splitTerminal` | `CmdOrCtrl+Shift+5` |
| `nextTerminal`, `previousTerminal` (tabs of the shown repo) | `CmdOrCtrl+Shift+]`, `CmdOrCtrl+Shift+[` |
| `findInTerminal`, `clearTerminal`, `killTerminal`, `terminalSettings` | none |
| `runTask` (the task list), `runBuildTask` | none, `CmdOrCtrl+Shift+B` |

Ctrl+Tab goes to the repo you saw before; pressing it again within 1.2 seconds goes one further back along the same order, so a single press toggles between the last two repos and quick presses reach older ones.

Rebind them in `keybindings.json` in the app's user data folder (File › Keyboard Shortcuts opens it), as `{ "command": "Accelerator" }` with [Electron accelerators](https://www.electronjs.org/docs/latest/api/accelerator); `null` removes a shortcut. The menu updates when the file is saved. Unknown commands and malformed shortcuts are skipped and reported on stderr.

Middle click on a repo in the rail closes it.

## License

MIT

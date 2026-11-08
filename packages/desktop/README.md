# @appling/desktop

Appling Desktop: one native app for many repos. Repos are grouped into workspaces, each repo gets its own Appling IDE server and a view that stays alive while you switch, with the model canvas, search and inspector as its main area.

In development (epic #15); the package is private until the first release. This is the shell with workspaces: the rail (collapsible, with pinned, reordered and hidden repos), one IDE server per repo, `.code-workspace` files, session restore, the fuzzy switcher, the app menu and rebindable shortcuts. Repos are added by folder or by cloning a git URL. The rail shows each repo's agent sessions, validation errors, unsaved files and git state (branch, ahead and behind, dirty). Each repo's IDE has a Review tab with the model diff against any commit. Each repo has a code view, an embedded Code OSS. It packages as an AppImage, an NSIS installer and a dmg, and updates itself from GitHub Releases. Task status in the rail and terminals follow.

To install a release, see [Desktop](https://appling.tools/docs/tools/desktop/) in the docs.

## Run it

```sh
pnpm build
node packages/desktop/out/bin.js [folders or .code-workspace files...]
```

`appling-desktop [paths...]` opens each `.code-workspace` file as a workspace and adds each folder (default: the current folder) to the active workspace, in the running app or in a new one. A second call hands its paths to the running instance and returns. Electron downloads its binary on the first start. Exit code 2 when an argument is neither a folder nor a `.code-workspace` file.

The packaged app takes the same paths without `bin.js` (`Appling.AppImage ~/work/shop`, relative to the current folder). `--version` prints the version and quits before any window opens, so it runs without a display.

## Workspaces

A workspace (for example a client or a product) groups git repos. It is a VS Code multi root workspace file, `<name>.code-workspace`, so you can commit it, share it and open it in VS Code too.

- **File › New Workspace…** creates the file where you choose (by default in the app's user data folder, `workspaces/`). Choosing an existing file opens it instead, so it is never emptied.
- **File › Open Workspace…** opens existing files, also ones written by VS Code. Comments and trailing commas are read; relative folder paths resolve against the file's folder; a folder's `name` is shown instead of its folder name; remote folders (`uri`) are kept but not opened.
- **File › Add Folder to Workspace…** adds folders to the active workspace. Folders opened while no workspace is open go to `workspaces/Default.code-workspace` in the user data folder.
- **File › Clone Repository…** (also on the `+` below the repos) asks for a git URL (https, ssh or a path) and the folder to clone into, proposed next to the workspace's first repo (else `~/src` or the home folder). It runs `git clone --progress` and shows its progress; when it is done the new folder joins the active workspace. A failure shows git's own message and removes the half cloned folder; Escape or Cancel stops a running clone. Git never asks for a password here: use a credential helper or an ssh agent.
- Adding, closing or moving a repo writes the file back: folder paths relative to the file, every other key (`settings`, `extensions`, ...) kept. Comments in the file are lost on that write. A file that does not parse is never overwritten; the app reports it instead.
- Right click a repo in the rail to pin it to the top, hide it, move it to another open workspace, reveal it or close it; right click a workspace to show its hidden repos again, reveal its file or close it. Dropping a repo on another workspace's button moves it there too. A move writes both workspace files.

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

- The **git state**: the branch (a short commit while the head is detached), the commits ahead of and behind its upstream and the number of changed files are in the repo's tooltip. A dot in the top left corner marks uncommitted changes, and `↑2↓1` in the bottom left corner the ahead and behind counts. It follows commits, checkouts, fetches and edits made anywhere, also in a terminal outside the app: the git folder is watched and `git status` runs every 5 seconds. Worktrees and submodules (a `.git` file) work too.
- **Drag** a repo onto another to place it before that one; it joins the group (pinned or not) of the repo it lands on. Drop it on the `+` below the repos to move it to the end. The new order is written to the workspace file's `folders`, so VS Code shows it too.

Pins, hidden repos and the collapsed rail are part of the session, not of the workspace file.

## Switcher

**Repo › Go to Repo…** (`CmdOrCtrl+P`) opens a fuzzy switcher over every repo of every open workspace, hidden ones included. Type a few letters of the name (they match in order, word starts and runs count most; a query may also start with the workspace name), use the arrows and Enter to go, Escape to leave. Without a query it lists the repos in most recently used order with the shown one last, so `CmdOrCtrl+P` then Enter goes back to the previous repo. A repo in two workspaces gets a line per workspace. While the switcher is open the repo views are hidden behind the shell page that draws it.

Several workspaces stay open at once. A folder may sit in more than one workspace; it is still one repo with one server and one view. A repo's server runs while any open workspace holds it, so switching repos or workspaces never reloads a view.

The open workspaces, the repo shown in each, the active workspace, the most recently used order, the pinned and hidden repos and whether the rail is collapsed are saved to `session.json` in the user data folder on every change and restored at the next start. Workspace files are read again then, so changes made in VS Code meanwhile show up; a file that is gone or broken is reported and left out.

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

## How it works

- `bin.ts` resolves the paths and starts Electron detached with `main.js -- <paths>`. The main process takes Electron's single instance lock with the paths as additional data; a second instance hands them to the first through `second-instance` and quits.
- `workspaces.ts` holds the pure state (open workspaces, the shown repo per workspace, pins and hidden repos, the rail order, the collapsed rail, the most recently used order); `switcher.ts` ranks the switcher's lines (`fuzzyMatch`, `switcherEntries`); `code-workspace.ts` reads and writes the files; `session.ts` saves and restores the session; `repos.ts` tracks the repos that have a server; `git.ts` reads the branch from `HEAD` without running git and the full state with `git status --porcelain=v2 --branch` (`parseGitStatus`, `readGitState`); `watchGit` follows it for the main process; `clone.ts` runs `git clone` with progress (`clone-ipc.ts` connects it to the shell's form).
- `rail-status.ts` is the rail's status model. Each feature reports through its own source, `rail.source('name').set(repo, { counts, branch, notes })` (or `replace` for every repo at once, `clear`), so no feature overwrites another's numbers; `repo(id)` sums the sources and `sum(repos)` a workspace. Sources today: `validation` (the server's error count), `editor` (unsaved files), `git` (branch, ahead, behind and dirty from `watchGit`) and `agents` (the agent sessions store, through `agentContributions`). A new count is a key of `RailCounts` and a place in `RAIL_COUNTS`, which orders them by urgency for the badge.
- Every repo runs `appling-ide <folder> --port 0` in its own child process (Electron's binary with `ELECTRON_RUN_AS_NODE`), so a failing repo cannot take the app down. The server reports its URL over the IPC channel, then `{ type: 'status', errors }` at start and after every model change and `{ type: 'status', unsaved }` (repo relative paths) whenever the files with unsaved edits change; the IDE client sends those to its server over `/events` (`{ type: 'unsaved', files }`). It ends when the channel closes, also when the app is killed. A server that ends shows its error with Retry and Close.
- The window holds the shell page (`src/shell`: the 48px rail with workspaces on top and the repos of the active workspace below, and the empty and error states) and one `WebContentsView` per repo loading `<ide url>/?shell=desktop`: the IDE client with the canvas as the main area, the source folded away behind **Source** and no AI chat. Views of inactive repos are hidden, not destroyed. A view may navigate only within its own server; `https` links open in the browser.
- `agent-sessions.ts`: the main process holds one store of agent sessions for every workspace and serves it to each repo's server over its IPC channel (`--shared-sessions`), with `desktopHost` adding the active repo, the workspace and the focus action to the sessions' IDE context. Agents reach the repo server's `/mcp` with their session's token (`openAgentSession`).
- The shell talks to the main process only through the preload bridge (`preload.cts`); every page runs sandboxed with context isolation. A repo view's own preload (`repo-preload.cts`) exposes `window.applingDesktop` for the code view's selection sync and `openTextDiff` (only where the code view runs).
- The code view: `code-download.ts` (pinned release, verified download), `code-server.ts` (one openvscode-server per repo: `--host 127.0.0.1 --port 0 --connection-token-file --server-base-path /r/<key>` with the shared `--user-data-dir`, `--extensions-dir` and `--server-data-dir`), `code-instances.ts` (the pure lifecycle: lazy start, idle suspend, always alive), `code-proxy.ts` (the one origin proxy, which swaps the cookie for each instance's token), `code-bridge.ts` (the extension channel), `code-settings.ts`, `vscode-cli.ts` and the Electron glue in `code-view.ts` (one kept alive `WebContentsView` per repo in the `persist:appling-code` session).

## Packaging

```sh
pnpm --filter @appling/desktop... build
pnpm --filter @appling/desktop package --linux   # or --win, --mac; more electron-builder flags pass through
```

`package` runs two steps. `scripts/bundle.mjs` writes `app/`: Desktop's main process (`out/main.js`, electron-updater and the parts of `@appling/ai` it uses included, with the AI skills and language pages in `skills/` and `language/` beside `out/`, the preload and the shell page) and each program Desktop runs, bundled by esbuild into one ESM file at the path of `BUNDLED` in `src/resources.ts`, next to the files its package reads at runtime:

| Program | In `app/` | Brings along |
|---|---|---|
| IDE server (`appling-ide`) | `ide/out/server/main.js` | `ide/dist/client/`, the AI skills and language pages in `ide/out/` |
| pty host (`appling-pty-host`) | `pty-host/out/main.js` | `pty-host/package.json` (its version) |
| language server (`appling-language-server`) | `lang/out/language-server.js` | |
| MCP server (`appling-mcp`) | `ai/out/main.js` | `ai/skills/`, `ai/language/` |

node-pty is native and not bundled: its JavaScript and this platform's native files (a local build on Linux, the prebuilds on Windows and macOS) are copied to `native/node-pty`, outside the asar archive. It is N-API, so the Node build loads in Electron without a rebuild. `APPLING_DESKTOP_VERSION` sets the app's version, else this package's is used; `--out <folder>` writes elsewhere. Then electron-builder (`electron-builder.config.mjs`) packs `app/` into `release/`: `Appling-<version>-linux-x86_64.AppImage`, `Appling-Setup-<version>-x64.exe`, `Appling-<version>-mac-{arm64,x64}.{dmg,zip}` and the `latest*.yml` update manifests. It installs and collects no `node_modules`; `app/` is complete.

`programPath(program)` (`src/resources.ts`) finds each program at run time: the bundled copy in the app's root (the folder above the bundled `out/main.js`) when it exists, else the built entry of the workspace package. `startIdeProcess` and the pty host's `startPtyHost({ main })` take the result, and every program runs with Electron's binary as Node (`ELECTRON_RUN_AS_NODE`).

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

## Shortcuts

| Command | Default |
|---|---|
| `newWorkspace`, `openWorkspace` | `CmdOrCtrl+Shift+N`, `CmdOrCtrl+Shift+O` |
| `open` (Add Folder to Workspace…) | `CmdOrCtrl+O` |
| `clone` (Clone Repository…) | none |
| `closeRepo` (removes it from the active workspace) | `CmdOrCtrl+W` |
| `switcher` (Go to Repo…) | `CmdOrCtrl+P` |
| `closeWorkspace` | `CmdOrCtrl+Shift+W` |
| `nextRepo`, `previousRepo` (most recently used order, across workspaces) | `Ctrl+Tab`, `Ctrl+Shift+Tab` |
| `repo1` … `repo9` (the rail's repos of the active workspace) | `CmdOrCtrl+1` … `CmdOrCtrl+9` |
| `nextWorkspace`, `previousWorkspace` | `CmdOrCtrl+PageDown`, `CmdOrCtrl+PageUp` |
| `workspace1` … `workspace9` | `CmdOrCtrl+Alt+1` … `CmdOrCtrl+Alt+9` |
| `toggleRail` | `CmdOrCtrl+B` |
| `toggleSource` | `CmdOrCtrl+E` |
| `toggleCode` (the code view) | `CmdOrCtrl+Alt+C` |
| `openFileInVSCode`, `openRepoInVSCode` | none |
| `reload` (the active repo's view) | `CmdOrCtrl+R` |
| `devTools` | `CmdOrCtrl+Alt+I` |
| `keybindings` (opens the keybindings file) | `CmdOrCtrl+K` |
| `checkForUpdates` | none |
| `quit` | `CmdOrCtrl+Q` |

Ctrl+Tab goes to the repo you saw before; pressing it again within 1.2 seconds goes one further back along the same order, so a single press toggles between the last two repos and quick presses reach older ones.

Rebind them in `keybindings.json` in the app's user data folder (File › Keyboard Shortcuts opens it), as `{ "command": "Accelerator" }` with [Electron accelerators](https://www.electronjs.org/docs/latest/api/accelerator); `null` removes a shortcut. The menu updates when the file is saved. Unknown commands and malformed shortcuts are skipped and reported on stderr.

Middle click on a repo in the rail closes it.

## License

MIT

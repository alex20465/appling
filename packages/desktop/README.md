# @appling/desktop

Appling Desktop: one native app for many repos. Repos are grouped into workspaces, each repo gets its own Appling IDE server and a view that stays alive while you switch, with the model canvas, search and inspector as its main area.

In development (epic #15); the package is private until the first release. This is the shell with workspaces: the rail (collapsible, with pinned, reordered and hidden repos), one IDE server per repo, `.code-workspace` files, session restore, the fuzzy switcher, the app menu and rebindable shortcuts. The rail shows each repo's validation errors and git branch. Cloning, agent, task and unsaved file status in the rail, terminals, agent sessions, the code view and packaging follow.

## Run it

```sh
pnpm build
node packages/desktop/out/bin.js [folders or .code-workspace files...]
```

`appling-desktop [paths...]` opens each `.code-workspace` file as a workspace and adds each folder (default: the current folder) to the active workspace, in the running app or in a new one. A second call hands its paths to the running instance and returns. Electron downloads its binary on the first start. Exit code 2 when an argument is neither a folder nor a `.code-workspace` file.

## Workspaces

A workspace (for example a client or a product) groups git repos. It is a VS Code multi root workspace file, `<name>.code-workspace`, so you can commit it, share it and open it in VS Code too.

- **File › New Workspace…** creates the file where you choose (by default in the app's user data folder, `workspaces/`). Choosing an existing file opens it instead, so it is never emptied.
- **File › Open Workspace…** opens existing files, also ones written by VS Code. Comments and trailing commas are read; relative folder paths resolve against the file's folder; a folder's `name` is shown instead of its folder name; remote folders (`uri`) are kept but not opened.
- **File › Add Folder to Workspace…** adds folders to the active workspace. Folders opened while no workspace is open go to `workspaces/Default.code-workspace` in the user data folder.
- Adding, closing or moving a repo writes the file back: folder paths relative to the file, every other key (`settings`, `extensions`, ...) kept. Comments in the file are lost on that write. A file that does not parse is never overwritten; the app reports it instead.
- Right click a repo in the rail to pin it to the top, hide it, move it to another open workspace, reveal it or close it; right click a workspace to show its hidden repos again, reveal its file or close it.

## The rail

The rail is 48px wide: workspaces on top, the repos of the active workspace below. **View › Toggle Rail** (`CmdOrCtrl+B`) folds it away so the repo view takes the whole window.

- **Pinned** repos (a green dot) stay at the top of the rail, in their workspace's folder order.
- **Hidden** repos leave the rail and `CmdOrCtrl+1..9`, which count the rail's repos. They keep their server and view, and the switcher still finds them; a hidden repo you switch to shows on the rail with a dotted border while it is shown. Pinning a hidden repo shows it again.
- **Validation errors** of a repo's model show as a red count in the corner of its button; a workspace's button shows the sum over all its repos, hidden ones included. The count follows every saved change of a `.appling` file.
- The **git branch** (a short commit while the head is detached) is in the repo's tooltip and follows checkouts made anywhere, also in a terminal outside the app. Worktrees and submodules (a `.git` file) work too.
- **Drag** a repo onto another to place it before that one; it joins the group (pinned or not) of the repo it lands on. Drop it on the `+` below the repos to move it to the end. The new order is written to the workspace file's `folders`, so VS Code shows it too.

Pins, hidden repos and the collapsed rail are part of the session, not of the workspace file.

## Switcher

**Repo › Go to Repo…** (`CmdOrCtrl+P`) opens a fuzzy switcher over every repo of every open workspace, hidden ones included. Type a few letters of the name (they match in order, word starts and runs count most; a query may also start with the workspace name), use the arrows and Enter to go, Escape to leave. Without a query it lists the repos in most recently used order with the shown one last, so `CmdOrCtrl+P` then Enter goes back to the previous repo. A repo in two workspaces gets a line per workspace. While the switcher is open the repo views are hidden behind the shell page that draws it.

Several workspaces stay open at once. A folder may sit in more than one workspace; it is still one repo with one server and one view. A repo's server runs while any open workspace holds it, so switching repos or workspaces never reloads a view.

The open workspaces, the repo shown in each, the active workspace, the most recently used order, the pinned and hidden repos and whether the rail is collapsed are saved to `session.json` in the user data folder on every change and restored at the next start. Workspace files are read again then, so changes made in VS Code meanwhile show up; a file that is gone or broken is reported and left out.

## How it works

- `bin.ts` resolves the paths and starts Electron detached with `main.js -- <paths>`. The main process takes Electron's single instance lock with the paths as additional data; a second instance hands them to the first through `second-instance` and quits.
- `workspaces.ts` holds the pure state (open workspaces, the shown repo per workspace, pins and hidden repos, the rail order, the collapsed rail, the most recently used order); `switcher.ts` ranks the switcher's lines (`fuzzyMatch`, `switcherEntries`); `code-workspace.ts` reads and writes the files; `session.ts` saves and restores the session; `repos.ts` tracks the repos that have a server; `git.ts` reads the branch from `HEAD` without running git, and the main process watches that file's folder.
- Every repo runs `appling-ide <folder> --port 0` in its own child process (Electron's binary with `ELECTRON_RUN_AS_NODE`), so a failing repo cannot take the app down. The server reports its URL over the IPC channel, then `{ type: 'status', errors }` at start and after every model change, and ends when the channel closes, also when the app is killed. A server that ends shows its error with Retry and Close.
- The window holds the shell page (`src/shell`: the 48px rail with workspaces on top and the repos of the active workspace below, and the empty and error states) and one `WebContentsView` per repo loading `<ide url>/?shell=desktop`: the IDE client with the canvas as the main area, the source folded away behind **Source** and no AI chat. Views of inactive repos are hidden, not destroyed. A view may navigate only within its own server; `https` links open in the browser.
- `agent-sessions.ts`: the main process holds one store of agent sessions for every workspace and serves it to each repo's server over its IPC channel (`--shared-sessions`), with `desktopHost` adding the active repo, the workspace and the focus action to the sessions' IDE context. Agents reach the repo server's `/mcp` with their session's token (`openAgentSession`).
- The shell talks to the main process only through the preload bridge (`preload.cts`); every page runs sandboxed with context isolation.

## Shortcuts

| Command | Default |
|---|---|
| `newWorkspace`, `openWorkspace` | `CmdOrCtrl+Shift+N`, `CmdOrCtrl+Shift+O` |
| `open` (Add Folder to Workspace…) | `CmdOrCtrl+O` |
| `closeRepo` (removes it from the active workspace) | `CmdOrCtrl+W` |
| `switcher` (Go to Repo…) | `CmdOrCtrl+P` |
| `closeWorkspace` | `CmdOrCtrl+Shift+W` |
| `nextRepo`, `previousRepo` (most recently used order, across workspaces) | `Ctrl+Tab`, `Ctrl+Shift+Tab` |
| `repo1` … `repo9` (the rail's repos of the active workspace) | `CmdOrCtrl+1` … `CmdOrCtrl+9` |
| `nextWorkspace`, `previousWorkspace` | `CmdOrCtrl+PageDown`, `CmdOrCtrl+PageUp` |
| `workspace1` … `workspace9` | `CmdOrCtrl+Alt+1` … `CmdOrCtrl+Alt+9` |
| `toggleRail` | `CmdOrCtrl+B` |
| `toggleSource` | `CmdOrCtrl+E` |
| `reload` (the active repo's view) | `CmdOrCtrl+R` |
| `devTools` | `CmdOrCtrl+Alt+I` |
| `keybindings` (opens the keybindings file) | `CmdOrCtrl+K` |
| `quit` | `CmdOrCtrl+Q` |

Ctrl+Tab goes to the repo you saw before; pressing it again within 1.2 seconds goes one further back along the same order, so a single press toggles between the last two repos and quick presses reach older ones.

Rebind them in `keybindings.json` in the app's user data folder (File › Keyboard Shortcuts opens it), as `{ "command": "Accelerator" }` with [Electron accelerators](https://www.electronjs.org/docs/latest/api/accelerator); `null` removes a shortcut. The menu updates when the file is saved. Unknown commands and malformed shortcuts are skipped and reported on stderr.

Middle click on a repo in the rail closes it.

## License

MIT

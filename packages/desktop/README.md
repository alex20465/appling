# @appling/desktop

Appling Desktop: one native app for many repos. Repos are grouped into workspaces, each repo gets its own Appling IDE server and a view that stays alive while you switch, with the model canvas, search and inspector as its main area.

In development (epic #15); the package is private until the first release. This is the shell with workspaces: the rail, one IDE server per repo, `.code-workspace` files, session restore, the app menu and rebindable shortcuts. Cloning, the fuzzy switcher, repo status in the rail, terminals, agent sessions, the code view and packaging follow.

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
- Right click a repo in the rail to move it to another open workspace, reveal it or close it; right click a workspace to reveal its file or close it.

Several workspaces stay open at once. A folder may sit in more than one workspace; it is still one repo with one server and one view. A repo's server runs while any open workspace holds it, so switching repos or workspaces never reloads a view.

The open workspaces, the repo shown in each, the active workspace and the most recently used order are saved to `session.json` in the user data folder on every change and restored at the next start. Workspace files are read again then, so changes made in VS Code meanwhile show up; a file that is gone or broken is reported and left out.

## How it works

- `bin.ts` resolves the paths and starts Electron detached with `main.js -- <paths>`. The main process takes Electron's single instance lock with the paths as additional data; a second instance hands them to the first through `second-instance` and quits.
- `workspaces.ts` holds the pure state (open workspaces, the shown repo per workspace, the most recently used order); `code-workspace.ts` reads and writes the files; `session.ts` saves and restores the session; `repos.ts` tracks the repos that have a server.
- Every repo runs `appling-ide <folder> --port 0` in its own child process (Electron's binary with `ELECTRON_RUN_AS_NODE`), so a failing repo cannot take the app down. The server reports its URL over the IPC channel and ends when the channel closes, also when the app is killed. A server that ends shows its error with Retry and Close.
- The window holds the shell page (`src/shell`: the 48px rail with workspaces on top and the repos of the active workspace below, and the empty and error states) and one `WebContentsView` per repo loading `<ide url>/?shell=desktop`: the IDE client with the canvas as the main area, the source folded away behind **Source** and no AI chat. Views of inactive repos are hidden, not destroyed. A view may navigate only within its own server; `https` links open in the browser.
- The shell talks to the main process only through the preload bridge (`preload.cts`); every page runs sandboxed with context isolation.

## Shortcuts

| Command | Default |
|---|---|
| `newWorkspace`, `openWorkspace` | `CmdOrCtrl+Shift+N`, `CmdOrCtrl+Shift+O` |
| `open` (Add Folder to Workspace…) | `CmdOrCtrl+O` |
| `closeRepo` (removes it from the active workspace) | `CmdOrCtrl+W` |
| `closeWorkspace` | `CmdOrCtrl+Shift+W` |
| `nextRepo`, `previousRepo` (most recently used order, across workspaces) | `Ctrl+Tab`, `Ctrl+Shift+Tab` |
| `repo1` … `repo9` (in the active workspace) | `CmdOrCtrl+1` … `CmdOrCtrl+9` |
| `nextWorkspace`, `previousWorkspace` | `CmdOrCtrl+PageDown`, `CmdOrCtrl+PageUp` |
| `workspace1` … `workspace9` | `CmdOrCtrl+Alt+1` … `CmdOrCtrl+Alt+9` |
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

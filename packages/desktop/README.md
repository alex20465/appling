# @appling/desktop

Appling Desktop: one native app for many repos. Each repo gets its own Appling IDE server and a view that stays alive while you switch, with the model canvas, search and inspector as its main area.

In development (epic #15); the package is private until the first release. This is the shell: repo rail, one IDE server per repo, app menu and rebindable shortcuts. Workspaces, terminals, agent sessions, the code view and packaging follow.

## Run it

```sh
pnpm build
node packages/desktop/out/bin.js [folders...]
```

`appling-desktop [folders...]` opens the folders (default: the current folder) in the running app, or starts it. A second call adds its folders to the running instance and returns. Electron downloads its binary on the first start. Exit code 2 when an argument is not a folder.

## How it works

- `bin.ts` resolves the folders and starts Electron detached with `main.js -- <folders>`. The main process takes Electron's single instance lock with the folders as additional data; a second instance hands them to the first through `second-instance` and quits.
- Every repo runs `appling-ide <folder> --port 0` in its own child process (Electron's binary with `ELECTRON_RUN_AS_NODE`), so a failing repo cannot take the app down. The server reports its URL over the IPC channel and ends when the channel closes, also when the app is killed. A server that ends shows its error with Retry and Close.
- The window holds the shell page (`src/shell`, the rail and the empty and error states) and one `WebContentsView` per repo loading `<ide url>/?shell=desktop`: the IDE client with the canvas as the main area, the source folded away behind **Source** and no AI chat. Views of inactive repos are hidden, not destroyed. A view may navigate only within its own server; `https` links open in the browser.
- The shell talks to the main process only through the preload bridge (`preload.cts`); every page runs sandboxed with context isolation.

## Shortcuts

| Command | Default |
|---|---|
| `open` (Open Folder…) | `CmdOrCtrl+O` |
| `closeRepo` | `CmdOrCtrl+W` |
| `nextRepo`, `previousRepo` | `Ctrl+Tab`, `Ctrl+Shift+Tab` |
| `repo1` … `repo9` | `CmdOrCtrl+1` … `CmdOrCtrl+9` |
| `toggleSource` | `CmdOrCtrl+E` |
| `reload` (the active repo's view) | `CmdOrCtrl+R` |
| `devTools` | `CmdOrCtrl+Alt+I` |
| `keybindings` (opens the keybindings file) | `CmdOrCtrl+K` |
| `quit` | `CmdOrCtrl+Q` |

Rebind them in `keybindings.json` in the app's user data folder (File › Keyboard Shortcuts opens it), as `{ "command": "Accelerator" }` with [Electron accelerators](https://www.electronjs.org/docs/latest/api/accelerator); `null` removes a shortcut. The menu updates when the file is saved. Unknown commands and malformed shortcuts are skipped and reported on stderr.

Middle click on a repo in the rail closes it.

## License

MIT

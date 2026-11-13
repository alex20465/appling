# @appling/inspect

The read only inspector of an Appling model, the companion you keep open next to an AI coding tool such as Claude Code, Codex or opencode. The agent changes the model and works through the generated project's registry tasks; the inspector shows it live: the model canvas, a floating inspector for the selected node, the task board and the marks of every change. It never writes a model file. `appling inspect` of [`@appling/cli`](../cli) and the [VS Code extension](../vscode) run its server once per repo. See https://appling.tools/docs/tools/inspect/.

```sh
appling inspect [folder]
node packages/inspect/out/server/main.js [folder] [--port 4410] [--shared-sessions]
```

An app starts it with an IPC channel and `--port 0` (`startInspectProcess` of `@appling/inspect/process`): the server reports `{ type: 'ready', url }`, the model errors and the implementation marks over IPC, and ends when the channel closes. With `--shared-sessions` it takes the agent sessions and the app host of the workspace over the same channel. It serves the folder's model on `127.0.0.1` and only answers pages it served itself.

The [VS Code extension](../vscode) shows the client in a tab: a webview iframe opened with `?host=frame`, where `src/client/frame-host.ts` offers the host hooks (`hooks.ts`) over `postMessage`. Where a host offers `openSource`, the inspector shows **Open source**. The server lets only itself and VS Code's webviews embed its page (`frame-ancestors`), and `{ type: 'trust', origin }` over IPC trusts one more origin. The colours and fonts are `--appling-*` CSS variables a host replaces with a `theme` message (`themeEvent`, `applyTheme`), and `data-theme="light"` picks the light palette. Where the host draws the side panels (the `panels` hook, `@appling/inspect/panels`), the client sends their state and takes their read only actions (`select`, `textDiff`, `review`). `@appling/inspect/host-requests` (`diffMessage`, `openMessage`) checks the client's requests to open a file against the repo.

`vite.demo.config.ts` builds the same client as the browser demo of the landing site (https://appling.tools/inspect/) into `dist/demo`: `src/demo/api.ts` answers every server call in the page from the sample model.

## What you get

- The model canvas, a tree that grows from a seed and unfolds on click: modules, then the declarations of the lens (Domain, Behavior, Application, Interfaces or Access), then what uses each declaration, grouped by kind. Each circle shows its name, kind and one fact; relevance decides its size and place, so the core of the business stands out. Each node's code state shows as a dot and a tag in words, explained by **Legend**. The lens and the link entities option are saved in `.appling/view.json`, the only file the inspector writes.
- The floating inspector over the right of the canvas for the selected node: kind, layer and qualified name, for an action what it does, who may trigger it and the invariants at risk, for an entity its actions with the transitions they drive, for an actor what that person may do and the policies that decide it, for a machine its reachable states, then its members and what uses it and what it uses, grouped by layer. Every link selects the next element; **×** closes it.
- The task board (`TaskBoard.tsx`, **Tasks** under the canvas): every registry task of the generated projects, in progress (claimed by an agent session), pending and done, in plan order. A click selects the task's element.
- Live changes: every model change, by an agent session or any process that writes the files, is marked on the canvas (added, changed, removed ghosted) without moving the camera, compared with git `HEAD`, following it after every commit, checkout or reset; outside git or before the first commit, with the files on disk when the server started.
- The repo's MCP server at `/mcp` for agent sessions (bearer token per session, `POST /api/sessions` opens one): agents label their work, set their status, claim elements and files and message each other; the canvas rings the claimed elements in the session's colour. `ide_context` reads what the person looks at, `ide_act` selects, reveals and highlights nodes, and the visual tools draw views and bubbles that wait as chips until the person opens them. A question typed in a session's view reaches its inbox (`POST /api/sessions/<id>/ask`).
- For hosts with a Review panel: the model diff between any commit and the working tree (`/api/diff`, `/api/revisions`), marked on the canvas with removed elements ghosted where they were.
- Once a release exists (`appling release`), the header shows how many migration steps were recorded since.

Everything updates when the files change on disk.

## License

MIT

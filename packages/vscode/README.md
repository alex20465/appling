# Appling for VS Code

Language support for [Appling](https://github.com/techthos/appling) models (`.appling` files), backed by the Appling language server, and the Appling repo view in a tab per project:

- Syntax highlighting
- Diagnostics: syntax, references across modules, layer rules, expression types, migrations
- Completion, go to definition, find references, rename, document symbols
- Hover with an element's kind, qualified name and layer
- Formatting into the canonical form (Format Document, or format on save)

All `.appling` files in the workspace are loaded together, so references between modules resolve across files.

## Projects, the IDE tab and agent sessions

In a plain VS Code window the extension also brings the Appling repo view in (`src/workbench.ts`):

- **Projects** in the Appling activity bar view: every folder with `appling.config.json`, and every workspace folder with `.appling` files outside one, with its modules (`src/projects.ts`). A click opens the project's IDE tab, on a module with the module selected. Without a model the view offers **Initialize Appling**, which runs the bundled `appling init` in a terminal.
- **The IDE tab**: one IDE server of `@appling/ide` per project (`startIdeProcess` of `@appling/ide/process`, on VS Code's Node), its client in a webview iframe opened with `?host=frame` (`src/frame.ts`). The client has no source pane and no side column there: its panels are native trees in the Appling sidebar (`src/panel-trees.ts`, `src/panels.ts`: Inspector, Changes, Playbook, Review, Code and Tasks; search is Go to Symbol in Workspace from the language server). Without a target, generating asks for the stack in a quick pick and offers to install its generator with npm; the bundled one runs meanwhile; **Open source**, **Open code**, text diffs and jumps to sessions open in VS Code after the paths are checked (`panelAction`, with `diffMessage` and `openMessage` of `@appling/ide/host-requests`).
- **Appling: Show in the IDE**, the Appling icon in the title bar of a `.appling` editor, opens the project's tab with the element at the cursor selected.
- **Implementation marks**: the gutter marks and CodeLenses below, from every project's server.
- **Agent Sessions**: agents of the built in presets and `appling.agents.presets` in VS Code terminals (`src/agents.ts`, VS Code free and tested with fake terminals; `src/agent-terminals.ts`, `src/agents-view.ts`), wired to their project's MCP server through the gateway of `@appling/ai/agents`, sharing one session store and playbook across the projects.

## Appling Desktop

In the code view of Appling Desktop (an embedded Code OSS) the extension is preinstalled and syncs the selection with the model canvas both ways: the cursor in a `.appling` file selects the element on the canvas, and an element selected on the canvas opens its source. `src/desktop-bridge.ts` holds that channel, a websocket to the Desktop main process given in `APPLING_DESKTOP_BRIDGE` with the token in `APPLING_DESKTOP_TOKEN`; without them the workbench above runs instead.

## Implementation marks

In both, the extension shows how far each model line is implemented (a gutter mark per element: implemented, partial, unimplemented, shifted or broken), puts a CodeLens **Appling: sales.Order** on code that implements an element (it selects the element on the canvas) and an **Open code** CodeLens on model lines with code; the command **Appling: Open the code of this element** opens it for the element at the cursor (`src/implementation.ts`, `src/implementation-view.ts`).

## Development

```sh
pnpm --filter "appling-vscode..." build   # the upstream packages, then scripts/bundle.mjs into out/ and out/appling.vsix
code --install-extension out/appling.vsix
pnpm host:link     # end to end testing: symlinks this folder into VS Code, Insiders and VSCodium (reload the window after a rebuild)
pnpm host:unlink   # removes the link again
```

`scripts/bundle.mjs` bundles the extension and the language server (CommonJS), the IDE server with its generation worker, client and the AI package's skills (`out/ide/`), the `appling` command line (`out/cli/`), the agents' command hook and the icon.

## License

MIT

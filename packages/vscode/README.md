# Appling for VS Code

Language support for [Appling](https://github.com/techthos/appling) models (`.appling` files), backed by the Appling language server:

- Syntax highlighting
- Diagnostics: syntax, references across modules, layer rules, expression types, migrations
- Completion, go to definition, find references, rename, document symbols
- Hover with an element's kind, qualified name and layer
- Formatting into the canonical form (Format Document, or format on save)

All `.appling` files in the workspace are loaded together, so references between modules resolve across files.

## Appling Desktop

In the code view of Appling Desktop (an embedded Code OSS) the extension is preinstalled and syncs the selection with the model canvas both ways: the cursor in a `.appling` file selects the element on the canvas, and an element selected on the canvas opens its source. `src/desktop-bridge.ts` holds that channel, a websocket to the Desktop main process given in `APPLING_DESKTOP_BRIDGE` with the token in `APPLING_DESKTOP_TOKEN`; without them it stays off.

## Development

```sh
pnpm --filter @appling/lang build
pnpm --filter appling-vscode build     # bundles the extension and the language server into out/, then out/appling.vsix
code --install-extension out/appling.vsix
```

## License

MIT

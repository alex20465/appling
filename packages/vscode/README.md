# Appling for VS Code

Language support for [Appling](https://github.com/techthos/appling) models (`.appling` files), backed by the Appling language server:

- Syntax highlighting
- Diagnostics: syntax, references across modules, layer rules, expression types, migrations
- Completion, go to definition, find references, rename, document symbols
- Hover with an element's kind, qualified name and layer
- Formatting into the canonical form (Format Document, or format on save)

All `.appling` files in the workspace are loaded together, so references between modules resolve across files.

## Development

```sh
pnpm --filter @appling/lang build
pnpm --filter appling-vscode build     # bundles the extension and the language server into out/
pnpm --filter appling-vscode package   # out/appling.vsix
code --install-extension out/appling.vsix
```

## License

MIT

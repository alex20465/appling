---
title: Editors
description: Use the Appling language server in any LSP capable editor, embed it in your own tool, or reuse its syntax highlighting.
---

`@appling/lang` ships a language server, `appling-language-server`, that speaks the Language Server Protocol. Any editor with an LSP client can use it for diagnostics, navigation and canonical formatting of `.appling` files. The same server runs in the VS Code extension.

## Install

```sh
npm install --global @appling/lang
appling-language-server --stdio
```

Or, without a global install:

```sh
npx -p @appling/lang appling-language-server --stdio
```

The server talks over stdin and stdout with `--stdio`. It is built on `vscode-languageserver`, so the other transports of that library, `--node-ipc` and `--socket=<port>`, work as well.

## Features

| Feature | What you get |
|---|---|
| Diagnostics | Syntax errors, unresolved references (also across modules and files), layer rules, expression types and migration checks: the same rules as `appling check` |
| Completion | Keywords and the names visible at the cursor |
| Go to definition | From any reference to its declaration, also in another file |
| Find references | Every reference to an element |
| Rename | The declaration and its references |
| Document highlight | Other occurrences of the element under the cursor |
| Document symbols | The outline of a file |
| Workspace symbols | Every element of the workspace by its qualified name (`sales.Order.status`), exported or not; VS Code's Go to Symbol in Workspace |
| Folding | Blocks such as modules, entities and actions |
| Hover | The element's kind, qualified name and layer, such as ``Field `sales.Order.status`, domain layer``, followed by its doc comment |
| Formatting | Rewrites the whole document into canonical form, the same as `appling fmt`; skipped while the file has syntax errors |

A doc comment is a `/** ... */` comment directly before an element:

```appling check
module sales {
  /** An order placed by a customer. */
  entity Order {
    reference: String unique
  }
}
```

The server loads every `.appling` file in the workspace folders the editor sends at startup, so references to files you have not opened resolve. Open your editor at the project root, the folder that contains all model files.

When the workspace folder is reached through a symlink and the editor opens a file under its real path, the server still keeps one document per file: the opened path replaces the copy it read from disk. Without that every declaration would exist twice, which shows as false errors such as `Unknown name "tenant".`.

> [!NOTE]
> Rename in the language server changes the declaration and its references. Export lists are references too, so it covers them. It does not follow names inside expressions (`total` in `{ total >= 0 }`), transitions over enum values, `@Name` in `does` texts or message keys. The `rename` [edit operation](../reference/edit-operations.md#rename), used by the [AI tools](ai.md), follows all of them.

## Implementation marks

In VS Code (see [VS Code](vscode.md)) the extension also shows the [implementation state](implementation.md):

- a gutter mark on each model line that declares an element: implemented, partial, unimplemented, shifted or broken, with the element in its hover,
- a CodeLens **Appling: sales.Order** above each code range that implements an element; it selects the element on the canvas of the project's inspector tab,
- a CodeLens **Open code** on model lines whose element has code, and the command **Appling: Open the code of this element** for the element at the cursor.

The inspector server of each project sends the marks after every model or reference change.

## Connect an editor

Every LSP client needs the same four facts:

| Setting | Value |
|---|---|
| Command | `appling-language-server --stdio` |
| Language id | `appling` |
| File pattern | `*.appling` |
| Root | The folder with `appling.config.json`, or your repository root |

Register `.appling` as a file type first if your editor does not know it, then point its LSP client at the command. Turn on format on save if you want files to stay canonical.

### Neovim

Neovim 0.11 and later configure language servers with `vim.lsp.config`. Put this in your `init.lua`:

```lua
vim.filetype.add({ extension = { appling = 'appling' } })

vim.lsp.config('appling', {
  cmd = { 'appling-language-server', '--stdio' },
  filetypes = { 'appling' },
  root_markers = { 'appling.config.json', '.git' },
})
vim.lsp.enable('appling')
```

Format with `vim.lsp.buf.format()`, rename with `vim.lsp.buf.rename()`, and hover with `K`.

### VS Code

The Appling extension for VS Code bundles the language server and a TextMate grammar generated from the Appling grammar, so it needs no global install. It starts when the workspace contains a `.appling` file or an `appling.config.json` or an `.appling` file is opened, and loads every model file in the workspace folders. It also brings the read only [inspector](inspect.md) into a tab per project, with agent sessions in VS Code terminals: see [VS Code](vscode.md). Build and install it from the repository (the build also writes `out/appling.vsix`):

```sh
pnpm --filter "appling-vscode..." build
code --install-extension packages/vscode/out/appling.vsix
```

Turn on `editor.formatOnSave` for `[appling]` to keep files canonical.

The extension also runs its own [projects, inspector tabs and agent sessions](vscode.md).

## Embed the language server

`@appling/lang/lsp` exports the services with Langium's LSP features plus the Appling formatter and hover. Use it to run the server over any connection, for example a websocket:

```ts
import { startLanguageServer } from 'langium/lsp';
import { NodeFileSystem } from 'langium/node';
import { createApplingLspServices } from '@appling/lang/lsp';

startLanguageServer(createApplingLspServices({ connection, ...NodeFileSystem }).shared);
```

`connection` is a `vscode-languageserver` connection, such as `createConnection(ProposedFeatures.all)` over stdio. On Node, pass `realPath` too, as `appling-language-server` does:

```ts
import { existsSync, realpathSync } from 'node:fs';

const realPath = (uri: { fsPath: string }) => existsSync(uri.fsPath) ? realpathSync(uri.fsPath) : uri.fsPath;
startLanguageServer(createApplingLspServices({ connection, ...NodeFileSystem, realPath }).shared);
```

| Export of `@appling/lang/lsp` | Purpose |
|---|---|
| `createApplingLspServices(context)` | The Appling services with Langium's LSP services; returns `{ shared, Appling }`. With `realPath` in the context, a function from a URI to the real path of its file, it keeps one document per file across symlinked paths |
| `ApplingLspModule` | The Appling specific LSP services, to inject into your own module |
| `ApplingDocumentUpdateHandler` | The document update handler that `realPath` turns on |
| `ApplingFormatter` | Formats a document into canonical form |
| `ApplingHoverProvider` | Hover with kind, qualified name, layer and doc comment |
| `ApplingWorkspaceSymbolProvider` | Every named element by qualified name; a shared service (`shared.lsp.WorkspaceSymbolProvider`) |

Without a `connection` in the context, `createApplingLspServices` marks its configuration as initialized, so you can use the LSP services directly in tests or tools.

## Syntax highlighting with Monarch

`@appling/lang/monarch` exports a [Monarch](https://microsoft.github.io/monaco-editor/monarch.html) grammar generated from the Appling grammar, for Monaco and other editors that read Monarch definitions:

```ts
import * as monaco from 'monaco-editor';
import monarch from '@appling/lang/monarch';

monaco.languages.register({ id: 'appling', extensions: ['.appling'] });
monaco.languages.setMonarchTokensProvider('appling', monarch as monaco.languages.IMonarchLanguage);
```

It produces the tokens `keyword`, `string`, `number`, `comment` and `operator`, so a Monaco theme can color them. Comments use `//` and `/* ... */`.

The package also ships the same grammar in TextMate form, `src/syntaxes/appling.tmLanguage.json` with the scope `source.appling`, for editors and highlighters that read TextMate grammars.

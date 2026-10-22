---
title: Editors
description: Use the Appling language server in any LSP capable editor, embed it in your own tool, or reuse its syntax highlighting.
---

`@appling/lang` ships a language server, `appling-language-server`, that speaks the Language Server Protocol. Any editor with an LSP client can use it for diagnostics, navigation and canonical formatting of `.appling` files. The same server runs inside the [IDE](ide.md).

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

> [!NOTE]
> Rename in the language server changes the declaration and its references. It does not follow names inside expressions (`total` in `{ total >= 0 }`), export lists, transitions over enum values or message keys. The `rename` [edit operation](../reference/edit-operations.md#rename), used by the IDE inspector and the [AI tools](ai.md), follows all of them.

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

The Appling extension for VS Code bundles the language server and a TextMate grammar generated from the Appling grammar, so it needs no global install. It starts when the workspace contains a `.appling` file and loads every model file in the workspace folders. Build and install it from the repository:

```sh
pnpm --filter @appling/lang build
pnpm --filter appling-vscode build
pnpm --filter appling-vscode package
code --install-extension packages/vscode/out/appling.vsix
```

Turn on `editor.formatOnSave` for `[appling]` to keep files canonical.

## Embed the language server

`@appling/lang/lsp` exports the services with Langium's LSP features plus the Appling formatter and hover. Use it to run the server over any connection, for example a websocket:

```ts
import { startLanguageServer } from 'langium/lsp';
import { NodeFileSystem } from 'langium/node';
import { createApplingLspServices } from '@appling/lang/lsp';

startLanguageServer(createApplingLspServices({ connection, ...NodeFileSystem }).shared);
```

`connection` is a `vscode-languageserver` connection. The IDE creates one per websocket with `vscode-ws-jsonrpc` and starts one server for each page.

| Export of `@appling/lang/lsp` | Purpose |
|---|---|
| `createApplingLspServices(context)` | The Appling services with Langium's LSP services; returns `{ shared, Appling }` |
| `ApplingLspModule` | The Appling specific LSP services, to inject into your own module |
| `ApplingFormatter` | Formats a document into canonical form |
| `ApplingHoverProvider` | Hover with kind, qualified name, layer and doc comment |

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

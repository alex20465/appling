---
title: Installation
description: Install the Appling CLI, connect an AI assistant and prepare the toolchains for code generation.
---

Appling is a set of npm packages. You only install what you use: the CLI is enough to write and check models; the VS Code extension, the MCP server and the code generators come on top.

> [!TIP]
> The quickest start is `npx @appling/cli init`. It installs the CLI, the AI package and the stack's generator into the project and connects your coding agents in one step. See [Start a new project](new-project.md). This page installs each part by hand.

## Requirements

- Node.js 24 or later.
- For code generation only, the toolchain of your target: [uv](https://docs.astral.sh/uv/) for Django, Elixir 1.17 or later with the `igniter_new` archive for Ash, Go 1.22 or later for Go, Rust 1.85 or later with Cargo for Rust. See the [Django](../codegen/django.md), [Ash](../codegen/ash.md), [Go](../codegen/go.md) and [Rust](../codegen/rust.md) pages for the exact requirements.

## The CLI

Add the CLI to your project as a development dependency:

```sh
npm install --save-dev @appling/cli
```

Or run it without installing:

```sh
npx @appling/cli check models
```

The package installs the `appling` command. Check that it works:

```sh
npx appling check
```

Without a path it checks every `.appling` file below the current folder. See [the CLI reference](../tools/cli.md) for every command.

## The inspector

`npx appling inspect` opens the [inspector](../tools/inspect.md) of the current folder in your browser, to follow the model next to your AI coding tool. In VS Code the [Appling extension](../tools/vscode.md) shows it in a tab per project. To try the canvas first, open the [demo](https://appling.tools/inspect/) in your browser.

## AI assistants

[`appling init`](new-project.md) connects Claude Code, Codex, OpenCode, Gemini CLI and Antigravity CLI: the MCP server, the rules and the skills. The MCP server also works with Claude Desktop and any other MCP client. To connect an agent by hand, install the server in the project and register it, here for Claude Code:

```sh
npm install --save-dev @appling/ai
claude mcp add appling -- npx appling-mcp .
```

In [VS Code](../tools/vscode.md#agent-sessions), agents started from the extension connect as [agent sessions](../tools/ai.md#agent-sessions) and show their work on the canvas. See [AI](../tools/ai.md).

## Code generators

`appling init --stack <stack>` installs the extension of your target and writes its entry in `appling.config.json`. By hand, install the extension next to the CLI, then list it in `appling.config.json`:

```sh
npm install --save-dev @appling/codegen-django
```

```json
{
  "generate": [
    { "extension": "@appling/codegen-django", "out": "build/shop", "options": { "name": "shop" } }
  ]
}
```

See [code generation](../codegen/overview.md).

## Editor support

Any editor with a language server client can use `appling-language-server --stdio` from `@appling/lang` for diagnostics, completion, rename and formatting. See [editors](../tools/editors.md).

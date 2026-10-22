---
title: Installation
description: Install the Appling CLI, open the IDE, connect an AI assistant and prepare the toolchains for code generation.
---

Appling is a set of npm packages. You only install what you use: the CLI is enough to write and check models; the IDE, the MCP server and the code generators come on top.

## Requirements

- Node.js 24 or later.
- For code generation only: [uv](https://docs.astral.sh/uv/) for the Django target, Elixir 1.17 or later with the `igniter_new` archive for the Ash target. See the [Django](../codegen/django.md) and [Ash](../codegen/ash.md) pages for the exact requirements.

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

## The IDE

The IDE runs locally and opens in your browser. It needs no installation:

```sh
npx @appling/ide models
```

Then open `http://127.0.0.1:4410`. Pass `--port` to use another port. See [the IDE](../tools/ide.md).

## AI assistants

The MCP server works with Claude Code, Claude Desktop and any other MCP client. For Claude Code, install it in the project and register it:

```sh
npm install --save-dev @appling/ai
claude mcp add appling -- npx appling-mcp .
```

The IDE chat needs an API key in the environment (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`). See [AI](../tools/ai.md).

## Code generators

Install the extension for your target next to the CLI, then list it in `appling.config.json`:

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

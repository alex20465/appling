---
name: ai-sdk-mcp
description: AI SDK 7, MCP SDK 1.32 and zod 4 as used by packages/ai (chat, tools, MCP server, registry tools) and the IDE chat endpoint. Use when adding or changing a tool, the chat stream, the MCP server or its HTTP transport, the registry workflow, or tests with MockLanguageModelV4.
metadata:
  anchors:
    - name: ai
      version: 7.0.149
      researched: 2026-10-23
    - name: "@ai-sdk/anthropic"
      version: 4.0.86
      researched: 2026-10-23
    - name: "@modelcontextprotocol/sdk"
      version: 1.32.1
      researched: 2026-10-23
    - name: zod
      version: 4.6.7
      researched: 2026-10-23
---

# AI SDK and MCP

Version deltas and internal contracts of the chat, the tools and the MCP server.

## Stream part shapes differ by layer

In `streamText().stream`, `text-delta` carries `.text` and `tool-call` carries a parsed `.input`. In the LanguageModelV4 parts a `MockLanguageModelV4` emits, `text-delta` carries `.delta` and needs `text-start`/`text-end` with an `id`, `tool-call.input` is a JSON string, and `finish` takes `finishReason: { unified, raw }` with nested `usage.inputTokens { total, noCache, cacheRead, cacheWrite }` and `outputTokens { total, text, reasoning }`. Source: `ai/dist/index.d.ts`, `@ai-sdk/provider@4.0.32/dist/index.d.ts`, `packages/ai/test/ai.test.ts`.

## Scripting a multi step test

`MockLanguageModelV4` (from `ai/test`) takes `doStream` as an array of stream results, one per model call; list the steps of a tool loop in order. Source: `ai/dist/test/index.d.ts`.

## Error surfaces

A thrown `execute` becomes a `tool-error` part and `streamText` reports provider errors as `error` parts instead of throwing. `chat()` forwards only `text-delta`, `tool-call` and `error`. Source: `ai/docs/03-ai-sdk-core/15-tools-and-tool-calling.mdx`, `50-error-handling.mdx`, https://ai-sdk.dev/docs/migration-guides/migration-guide-7-0

## Stateless Streamable HTTP

With `sessionIdGenerator: undefined` a transport cannot be reused ("Stateless transport cannot be reused"), so `serveHttp` creates a server and a transport per request. `allowedHosts` and `enableDnsRebindingProtection` still work but are deprecated in favour of `hostHeaderValidation` and `localhostHostValidation`. The hosts list is filled after `listen` so port 0 works. Source: `@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.d.ts`, `packages/ai/src/mcp.ts`.

## MCP tool results

Results are `JSON.stringify(result, null, 2)` as one text content item, with no `outputSchema` or `structuredContent`. Tests read them with `JSON.parse(content[0].text)`. Source: `packages/ai/src/mcp.ts`.

## A chat turn

- Every turn builds a fresh `ProposalContext` from disk.
- The client resends only `{ role, content: string }` text turns, without earlier tool calls or results.
- NDJSON events are `text`, `tool`, `proposal` and `error`; the proposal comes last and only when there were edits.
- On Accept the client replays `proposal.operations` one by one through `/api/edit`; `hunks` and `graph` are display only.
- A `dryRun` edit is validated and never recorded.

Source: `packages/ai/src/chat.ts`, `tools.ts`, `packages/ide/src/client/api.ts`, `Chat.tsx`.

## Registry tools

- `nextTask` returns the first `todo` or `partial` entry that still has `missing` items and fewer than `MAX_ATTEMPTS` (3) attempts.
- `updateTask` always counts an attempt; `done` clears `missing`; when attempts run out it notes "stopped after N attempts".
- `runTests` runs `registry.test` with `spawnSync` and returns the last 4000 characters.
- `REGISTRY_PROMPT` reads `../skills/appling-registry/SKILL.md` relative to `out/` and strips the frontmatter.

Source: `packages/ai/src/project.ts`, `prompts.ts`.

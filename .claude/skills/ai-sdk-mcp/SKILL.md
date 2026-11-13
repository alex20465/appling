---
name: ai-sdk-mcp
description: MCP SDK 1.32 and zod 4 as used by packages/ai (tools, MCP server, agent session and visual tools, registry tools) and the inspector server's /mcp. Use when adding or changing a tool, the MCP server or its HTTP transport, or the registry workflow.
metadata:
  anchors:
    - name: "@modelcontextprotocol/sdk"
      version: 1.32.1
      researched: 2026-10-23
    - name: zod
      version: 4.6.7
      researched: 2026-10-23
---

# MCP

Version deltas and internal contracts of the tools and the MCP server. The AI SDK chat of the browser IDE is gone (decision 7C of #15), and so are proposals.

## Stateless Streamable HTTP

With `sessionIdGenerator: undefined` a transport cannot be reused ("Stateless transport cannot be reused"), so `serveHttp` creates a server and a transport per request. `allowedHosts` and `enableDnsRebindingProtection` still work but are deprecated in favour of `hostHeaderValidation` and `localhostHostValidation`. The hosts list is filled after `listen` so port 0 works. Source: `@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.d.ts`, `packages/ai/src/mcp.ts`.

## MCP tool results

Results are `JSON.stringify(result, null, 2)` as one text content item, with no `outputSchema` or `structuredContent`. Tests read them with `JSON.parse(content[0].text)`. Source: `packages/ai/src/mcp.ts`.

## Edits

- A `dryRun` edit is validated and never recorded.
- There are no proposals: `propose_edits` and `proposal.ts` are gone with the read only inspector. Agents change the model with `edit`, and the inspector marks every change live.

Source: `packages/ai/src/tools.ts`, `packages/inspect/src/server/visuals.ts`.

## Registry tools

- `nextTask` returns the first `todo` or `partial` entry that still has `missing` items and fewer than `MAX_ATTEMPTS` (3) attempts.
- `updateTask` always counts an attempt; `done` clears `missing`; when attempts run out it notes "stopped after N attempts".
- `runTests` runs `registry.test` with `spawnSync` and returns the last 4000 characters.
- `REGISTRY_PROMPT` reads `../skills/appling-registry/SKILL.md` relative to `out/` and strips the frontmatter.

Source: `packages/ai/src/project.ts`, `prompts.ts`.

---
paths:
  - packages/ai/**
  - packages/ide/src/server/server.ts
---

# MCP

- Return tool failures as values (`{ ok: false, errors }`, `{ error }`), never throw.
- Define a tool's `input` in `tools.ts` as a zod raw shape, not `z.object`; MCP takes it as is.
- Use `registerTool` and `registerPrompt`; `server.tool()` and `server.prompt()` are deprecated.
- Do not add zod 3 or `zod-to-json-schema`; the MCP SDK accepts zod 4.
- Never write to stdout on the stdio MCP path; log with `console.error`.
- Do not bring back a built in chat, the AI SDK or a stdio visual window (decision 7C of #15): AI runs through agent sessions in Appling Desktop, and the visual tools exist only on the IDE server's `/mcp`.
- Keep `skills` in the package `files`; `REGISTRY_PROMPT` reads the skill at runtime.
- Before changing these files, use the `ai-sdk-mcp` skill.

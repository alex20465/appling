---
paths:
  - packages/ai/**
  - packages/ide/src/server/server.ts
  - packages/ide/src/client/Chat.tsx
---

# AI SDK and MCP

- In new code use `isStepCount`, `instructions` and `result.stream`; `stepCountIs`, `system` and `fullStream` are deprecated aliases in ai 7.
- Never put a `system` role in `messages` or set `allowSystemInMessages`; `/api/chat` forwards client messages unchanged.
- Return tool failures as values (`{ ok: false, errors }`, `{ error }`), never throw; `chat()` does not forward `tool-error` parts.
- Define a tool's `input` in `tools.ts` as a zod raw shape, not `z.object`; MCP takes it as is and `aiTools` wraps it.
- Do not pass the repo's `ToolContext` through ai's `toolsContext`; it is bound by closure in `aiTools`.
- Use `registerTool` and `registerPrompt`; `server.tool()` and `server.prompt()` are deprecated.
- Do not add zod 3 or `zod-to-json-schema`; the MCP SDK accepts zod 4.
- Never write to stdout on the stdio MCP path; log with `console.error`.
- Keep `skills` in the package `files`; `REGISTRY_PROMPT` reads the skill at runtime.
- Before changing these files, use the `ai-sdk-mcp` skill.

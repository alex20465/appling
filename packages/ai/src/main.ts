#!/usr/bin/env node
import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer, serveHttp } from './mcp.js';

const args = process.argv.slice(2);
const httpIndex = args.indexOf('--http');
const root = resolve(args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--http') ?? '.');

// The model, authoring, registry and reference tools; the visual tools are on the IDE server's /mcp of an agent
// session in Appling Desktop, where the canvas is.
if (httpIndex >= 0) {
    const server = await serveHttp(root, Number(args[httpIndex + 1] ?? 4411));
    console.error(`Appling MCP server for ${root} at ${server.url}`);
} else {
    await createMcpServer(root).connect(new StdioServerTransport());
}

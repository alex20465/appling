#!/usr/bin/env node
import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Visualizer } from '@appling/viz';
import { createMcpServer, serveHttp } from './mcp.js';
import { Project } from './project.js';

const args = process.argv.slice(2);
const httpIndex = args.indexOf('--http');
const root = resolve(args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--http') ?? '.');

if (httpIndex >= 0) {
    const server = await serveHttp(root, Number(args[httpIndex + 1] ?? 4411));
    console.error(`Appling MCP server for ${root} at ${server.url}`);
} else {
    const project = new Project(root);
    const visualizer = new Visualizer({ root, graph: () => project.graph() });
    const server = createMcpServer(root, { visualizer });
    server.server.onclose = () => visualizer.close();
    await server.connect(new StdioServerTransport());
}

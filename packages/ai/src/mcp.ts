import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Project } from './project.js';
import { REGISTRY_PROMPT } from './prompts.js';
import { diskContext, MODEL_TOOLS, REGISTRY_TOOLS, type Tools } from './tools.js';

/** An MCP server over one workspace folder: model tools, registry tools and the registry prompt. */
export function createMcpServer(root: string): McpServer {
    const context = diskContext(new Project(root));
    const server = new McpServer({ name: 'appling', version: '0.1.0' });
    for (const [name, tool] of Object.entries({ ...MODEL_TOOLS, ...REGISTRY_TOOLS } as Tools)) {
        server.registerTool(name, { description: tool.description, inputSchema: tool.input }, async (input: Record<string, unknown>) => {
            const result = await tool.run(context, input);
            return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        });
    }
    server.registerPrompt('implement_next_task', { description: 'Work through the open tasks of a generated project, one at a time.' }, () => ({
        messages: [{ role: 'user' as const, content: { type: 'text' as const, text: REGISTRY_PROMPT } }]
    }));
    return server;
}

/** Serves the MCP server over Streamable HTTP on 127.0.0.1, one stateless transport per request. */
export async function serveHttp(root: string, port: number): Promise<{ url: string, close(): Promise<void> }> {
    let hosts: string[] = [];
    const http = createServer(async (request, response) => {
        if (request.url !== '/mcp') {
            response.writeHead(404).end();
            return;
        }
        const server = createMcpServer(root);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableDnsRebindingProtection: true, allowedHosts: hosts });
        response.on('close', () => {
            transport.close();
            server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(request, response);
    });
    await new Promise<void>(done => http.listen(port, '127.0.0.1', done));
    const address = http.address() as { port: number };
    hosts = [`127.0.0.1:${address.port}`, `localhost:${address.port}`];
    return { url: `http://127.0.0.1:${address.port}/mcp`, close: () => new Promise(done => http.close(() => done())) };
}

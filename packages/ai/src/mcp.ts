import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Project } from './project.js';
import { MCP_INSTRUCTIONS, REGISTRY_PROMPT, REVERSE_PROMPT } from './prompts.js';
import { AUTHORING_TOOLS, diskContext, MODEL_TOOLS, REFERENCE_TOOLS, REGISTRY_TOOLS, type Tools } from './tools.js';
import { VISUAL_INSTRUCTIONS, visualTools, type VisualHost } from './visual.js';

/**
 * An MCP server over one workspace folder: model tools, registry tools, the prompts, and instructions that make the
 * model the source of truth for business logic. With a visualizer it also drives the floating window and is a
 * Claude Code channel, so questions typed there reach the session.
 */
export function createMcpServer(root: string, options: { visualizer?: VisualHost } = {}): McpServer {
    const context = diskContext(new Project(root));
    const { visualizer } = options;
    const server = new McpServer({ name: 'appling', version: '0.1.0' }, {
        capabilities: visualizer && { experimental: { 'claude/channel': {} } },
        instructions: visualizer ? `${MCP_INSTRUCTIONS}\n\n${VISUAL_INSTRUCTIONS}` : MCP_INSTRUCTIONS
    });
    visualizer?.onAsk(ask => server.server.notification({
        method: 'notifications/claude/channel',
        params: { content: ask.text, meta: { ask_id: ask.id, selected: ask.selected ?? '', view: ask.view ? `${ask.view.view} ${ask.view.focus.join(' ')}` : '' } }
    }).catch(error => console.error(error)));
    const visual = visualizer ? visualTools(visualizer) : {};
    for (const [name, tool] of Object.entries({ ...MODEL_TOOLS, ...AUTHORING_TOOLS, ...REGISTRY_TOOLS, ...REFERENCE_TOOLS, ...visual } as Tools)) {
        server.registerTool(name, { description: tool.description, inputSchema: tool.input }, async (input: Record<string, unknown>) => {
            const result = await tool.run(context, input);
            return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        });
    }
    server.registerPrompt('implement_next_task', { description: 'Work through the open tasks of a generated project, one at a time.' }, () => ({
        messages: [{ role: 'user' as const, content: { type: 'text' as const, text: REGISTRY_PROMPT } }]
    }));
    server.registerPrompt('derive_model', { description: 'Derive an Appling model from an existing application.' }, () => ({
        messages: [{ role: 'user' as const, content: { type: 'text' as const, text: REVERSE_PROMPT } }]
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

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Project } from './project.js';
import { MCP_INSTRUCTIONS, REGISTRY_PROMPT, REVERSE_PROMPT } from './prompts.js';
import { AUTHORING_TOOLS, diskContext, MODEL_TOOLS, REFERENCE_TOOLS, REGISTRY_TOOLS, type Tools } from './tools.js';
import { VISUAL_INSTRUCTIONS, visualTools, type VisualHost } from './visual.js';
import { conflictWarning, SESSION_INSTRUCTIONS, sessionTools, touchedBy, type SessionScope } from './session-tools.js';
import { findConflicts } from './sessions.js';
import { PLAYBOOK_INSTRUCTIONS, playbookTools } from './playbook-tools.js';

export interface McpServerOptions {
    /** Where the visual tools draw: the project's canvas. Without it there are no visual tools. */
    visualizer?: VisualHost;
    session?: SessionScope;
    /** Called after every tool call with its input and result, such as to attribute the files it wrote to its session. */
    onToolCall?(tool: string, input: Record<string, unknown>, result: unknown): void;
}

/**
 * An MCP server over one workspace folder: model tools, registry tools, the prompts, and instructions that make the
 * model the source of truth for business logic. With a visualizer it also drives the project's canvas. With a
 * session, every tool call is attributed to it, the session tools coordinate it with the other agent sessions, and edits that touch their claims come back with
 * a warning.
 */
export function createMcpServer(root: string, options: McpServerOptions = {}): McpServer {
    const context = diskContext(new Project(root));
    const { visualizer, session, onToolCall } = options;
    const instructions = [MCP_INSTRUCTIONS, visualizer && VISUAL_INSTRUCTIONS, session && SESSION_INSTRUCTIONS, session?.playbook && PLAYBOOK_INSTRUCTIONS].filter(Boolean).join('\n\n');
    const server = new McpServer({ name: 'appling', version: '0.1.0' }, { instructions });
    const visual = visualizer ? visualTools(visualizer) : {};
    const sessions = session ? { ...sessionTools(session), ...session.playbook ? playbookTools(session.id, session.store, session.playbook) : {} } : {};
    for (const [name, tool] of Object.entries({ ...MODEL_TOOLS, ...AUTHORING_TOOLS, ...REGISTRY_TOOLS, ...REFERENCE_TOOLS, ...visual, ...sessions } as Tools)) {
        server.registerTool(name, { description: tool.description, inputSchema: tool.input }, async (input: Record<string, unknown>) => {
            const raw = await tool.run(context, input);
            try {
                onToolCall?.(name, input, raw);
            } catch (error) {
                console.error(error);
            }
            const result = session ? await attributed(session, name, input, raw) : raw;
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

/**
 * Attributes a tool call to its session, adds a warning when it touched another session's claims and a notice when
 * messages wait. Failures of the store never fail the tool call.
 */
async function attributed(scope: SessionScope, tool: string, input: Record<string, unknown>, result: unknown): Promise<unknown> {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
        await scope.store.touch(scope.id, tool).catch(() => undefined);
        return result;
    }
    const extra: Record<string, unknown> = {};
    try {
        await scope.store.touch(scope.id, tool);
        const self = await scope.store.get(scope.id);
        const touched = touchedBy(tool, input, result);
        const ok = (result as { ok?: boolean }).ok !== false && !('error' in result);
        if (self && ok && (touched.elements?.length || touched.files?.length)) {
            const conflicts = findConflicts(await scope.store.list(), self, touched);
            if (conflicts.length) Object.assign(extra, { conflicts, warning: conflictWarning(conflicts) });
        }
        if (self?.unread && tool !== 'session_inbox') extra.messages = `${self.unread} unread message(s) from other sessions: read them with session_inbox.`;
    } catch (error) {
        console.error(error);
    }
    return { ...result, ...extra };
}

/**
 * Answers one Streamable HTTP request with a server of its own, statelessly: a stateless transport cannot be reused.
 * With hosts, requests for other Host headers are refused (DNS rebinding).
 */
export async function handleMcpRequest(server: McpServer, request: IncomingMessage, response: ServerResponse, hosts?: string[]): Promise<void> {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, ...(hosts ? { enableDnsRebindingProtection: true, allowedHosts: hosts } : {}) });
    response.on('close', () => {
        transport.close();
        server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request, response);
}

/** Serves the MCP server over Streamable HTTP on 127.0.0.1, one stateless transport per request. */
export async function serveHttp(root: string, port: number): Promise<{ url: string, close(): Promise<void> }> {
    let hosts: string[] = [];
    const http = createServer(async (request, response) => {
        if (request.url !== '/mcp') {
            response.writeHead(404).end();
            return;
        }
        await handleMcpRequest(createMcpServer(root), request, response, hosts);
    });
    await new Promise<void>(done => http.listen(port, '127.0.0.1', done));
    const address = http.address() as { port: number };
    hosts = [`127.0.0.1:${address.port}`, `localhost:${address.port}`];
    return { url: `http://127.0.0.1:${address.port}/mcp`, close: () => new Promise(done => http.close(() => done())) };
}

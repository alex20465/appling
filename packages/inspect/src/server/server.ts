import { watch, existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { createMcpServer, handleMcpRequest, MemorySessionStore, touchedBy, type AppHost, type SessionStore } from '@appling/ai';
import { latestRelease, readReleases, REFERENCES, type LineMark } from '@appling/model';
import { CONFIG, GENERATIONS, readConfig, REGISTRY } from '@appling/codegen';
import type { Snapshot } from '../shared/snapshot.js';
import { git, review, revisions } from './git.js';
import { codeLinks, fileMarks, readView, snapshot, writeView } from './workspace.js';
import { ideHost, type ClientContext } from './sessions.js';
import { LiveTracker } from './live.js';
import { AgentViews } from './visuals.js';

const CLIENT = fileURLToPath(new URL('../../dist/client/', import.meta.url));
// every ancestor counts: the webview's own frames (vscode-webview:) and the desktop workbench (vscode-file://vscode-app)
const FRAME_ANCESTORS = "frame-ancestors 'self' vscode-webview: vscode-file: https://*.vscode-cdn.net";
const TYPES: Record<string, string> = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2', '.json': 'application/json', '.ttf': 'font/ttf'
};

export interface Inspect {
    url: string;
    /** The repo's MCP server; agents reach it with a session's token as bearer token. */
    mcp: string;
    sessions: SessionStore;
    /** Trusts one more origin from now on, such as where VS Code forwarded this server's port (`asExternalUri`). */
    trust(origin: string): void;
    close(): Promise<void>;
}

export interface InspectOptions {
    /** Called with every snapshot the server pushes after a model file changed. */
    onSnapshot?(snapshot: Snapshot): void;
    /** The agent sessions, shared by the repos of a workspace; default: a store of this server's own. */
    sessions?: SessionStore;
    /** What the app around the inspector adds to a session's context and does with its actions, such as VS Code. */
    host?: AppHost;
    /** Called with the implementation marks of the model files and the code references by file, after every snapshot (the VS Code extension shows them). */
    onImplementation?(implementation: Implementation): void;
}

/** The implementation state for an editor: marks by model file and links from code back to elements, by absolute path. */
export interface Implementation {
    marks: Record<string, LineMark[]>;
    links: Record<string, { qn: string, start: number, end: number }[]>;
}

/** Serves the inspector of one workspace folder on 127.0.0.1, read only. */
export async function startInspect(root: string, port = 0, options: InspectOptions = {}): Promise<Inspect> {
    const events = new Set<WebSocket>();
    let origins: string[] = [];
    const sessions = options.sessions ?? new MemorySessionStore();
    const client: ClientContext = {};
    const broadcast = (message: unknown) => {
        const text = JSON.stringify(message);
        events.forEach(ws => ws.send(text));
    };
    const host = ideHost(root, client, () => events.size, broadcast, options.host);
    const views = new AgentViews(broadcast, client, () => events.size);
    const live = new LiveTracker(root, state => broadcast({ type: 'live', live: state }));
    const stopSessions = sessions.onChange(list => {
        broadcast({ type: 'sessions', sessions: list });
        views.prune(list.map(s => s.id));
    });
    const agents: Agents = { live, views, sessions, host };

    const server = createServer((request, response) => {
        if (!trusted(request, origins)) return send(response, 403, 'Forbidden');
        const work = request.url === '/mcp' ? serveMcp(request, response, root, agents)
            : request.url?.startsWith('/api/sessions') ? serveSessions(request, response, root, sessions, views)
            : handle(request, response, root);
        work.catch(error => response.headersSent ? response.end() : send(response, 500, String(error)));
    });
    const sockets = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
        if (!trusted(request, origins)) return socket.destroy();
        sockets.handleUpgrade(request, socket, head, ws => {
            const path = new URL(request.url!, 'http://localhost').pathname;
            if (path === '/events') {
                events.add(ws);
                ws.on('close', () => events.delete(ws));
                // The client reports what it shows, for the sessions' ide_context.
                ws.on('message', data => {
                    try {
                        const message = JSON.parse(data.toString()) as { type?: string } & ClientContext;
                        if (message.type === 'context') Object.assign(client, { selection: message.selection, view: message.view, watching: message.watching });
                    } catch {
                        // not JSON: ignored
                    }
                });
                sessions.list().then(list => ws.send(JSON.stringify({ type: 'sessions', sessions: list })), () => undefined);
                ws.send(JSON.stringify({ type: 'live', live: live.current() }));
                for (const view of views.all()) ws.send(JSON.stringify({ type: 'agent-view', view }));
            } else ws.close();
        });
    });

    let timer: NodeJS.Timeout | undefined;
    /** Besides the model files: the config, the code references, the generation records and the targets' registries. */
    const state = () => [CONFIG, REFERENCES, GENERATIONS, ...(readConfig(root).generate ?? []).map(t => relative(root, resolve(root, t.out, REGISTRY)))];
    const report = (current: Snapshot) => options.onImplementation?.({ marks: fileMarks(current), links: codeLinks(root, current) });
    const refresh = () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
            const current = await snapshot(root);
            const message = JSON.stringify({ type: 'snapshot', snapshot: current });
            events.forEach(ws => ws.send(message));
            options.onSnapshot?.(current);
            report(current);
            await live.update(current).catch(error => console.error(error));
        }, 100);
    };
    const watcher = watch(root, { recursive: true }, (_, file) => {
        if (!file) return;
        const model = file.endsWith('.appling') && !file.split(sep).some(part => part.startsWith('.') || part === 'node_modules');
        if (model || state().includes(file)) refresh();
    });
    if (options.onImplementation) snapshot(root).then(report, error => console.error(error));
    // the marks start against HEAD and follow it: a commit, checkout or reset rewrites files in the git folder
    let head: NodeJS.Timeout | undefined;
    const followHead = () => live.followHead().catch(error => console.error(error));
    const gitDir = await git(root, ['rev-parse', '--absolute-git-dir']).then(out => out.trim(), () => undefined);
    const headWatcher = gitDir ? watch(gitDir, () => {
        clearTimeout(head);
        head = setTimeout(followHead, 200);
    }) : undefined;
    void followHead().then(() => snapshot(root)).then(current => live.update(current)).catch(error => console.error(error));

    await new Promise<void>(done => server.listen(port, '127.0.0.1', done));
    const address = server.address() as { port: number };
    origins = [`http://127.0.0.1:${address.port}`, `http://localhost:${address.port}`];
    return {
        url: origins[0],
        mcp: `${origins[0]}/mcp`,
        sessions,
        trust: origin => {
            if (/^https?:\/\/[\w.-]+(:\d+)?$/.test(origin) && !origins.includes(origin)) origins.push(origin);
        },
        close: () => new Promise(done => {
            stopSessions();
            watcher.close();
            headWatcher?.close();
            clearTimeout(timer);
            clearTimeout(head);
            sockets.clients.forEach(ws => ws.terminate());
            server.close(() => done());
            // Agents' MCP clients keep their connections alive.
            server.closeAllConnections();
        })
    };
}

interface Agents {
    live: LiveTracker;
    views: AgentViews;
    sessions: SessionStore;
    host: ReturnType<typeof ideHost>;
}

/**
 * The repo's MCP server for one agent session, named by the bearer token of the request. Its visual tools draw on
 * this repo's canvas, and the files its tool calls write are attributed to it in the live changes.
 */
async function serveMcp(request: IncomingMessage, response: ServerResponse, root: string, { live, views, sessions, host }: Agents): Promise<void> {
    const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1];
    const id = token && await sessions.authenticate(token);
    if (!id) {
        response.writeHead(401, { 'content-type': 'text/plain', 'www-authenticate': 'Bearer' });
        response.end('An agent session token is required.');
        return;
    }
    const onToolCall = (tool: string, input: Record<string, unknown>, result: unknown) => {
        const files = touchedBy(tool, input, result).files ?? [];
        const ok = !!result && typeof result === 'object' && (result as { ok?: boolean }).ok !== false && !('error' in result);
        if (ok && files.length) live.attribute(id, files).catch(error => console.error(error));
    };
    await handleMcpRequest(createMcpServer(root, { session: { id, store: sessions, host }, visualizer: views.host(id), onToolCall }), request, response);
}

/**
 * The sessions for the inspector client and for an inspect server without an app that holds them: list, open
 * (returns the token and the MCP URL once), rename or set the status as the user, end, and `POST /api/sessions/<id>/ask` (`{ text }`): a
 * question the user typed in the session's view, delivered to its inbox.
 */
async function serveSessions(request: IncomingMessage, response: ServerResponse, root: string, sessions: SessionStore, views: AgentViews): Promise<void> {
    const path = request.url!.slice('/api/sessions'.length).replace(/^\//, '');
    const ask = /^([^/]+)\/ask$/.exec(path);
    if (ask && request.method === 'POST') {
        const text = String((JSON.parse(await body(request) || '{}') as { text?: unknown }).text ?? '').trim();
        if (!text) return send(response, 400, 'A question is required.');
        try {
            await views.ask(sessions, decodeURIComponent(ask[1]), text);
        } catch (error) {
            return send(response, 404, (error as Error).message);
        }
        return json(response, { delivered: true });
    }
    const id = decodeURIComponent(path);
    if (!id && request.method === 'GET') return json(response, await sessions.list());
    if (!id && request.method === 'POST') {
        const input = JSON.parse(await body(request) || '{}') as { name?: string, label?: string, workspace?: string };
        const opened = await sessions.open({ name: input.name, label: input.label, workspace: input.workspace, repo: root });
        return json(response, { ...opened, mcp: `http://${request.headers.host}/mcp` });
    }
    try {
        if (id && request.method === 'PATCH') return json(response, await sessions.update(id, JSON.parse(await body(request))));
        if (id && request.method === 'DELETE') {
            await sessions.end(id);
            return send(response, 204, '');
        }
    } catch (error) {
        return send(response, 404, (error as Error).message);
    }
    send(response, 405, 'Method not allowed');
}

async function handle(request: IncomingMessage, response: ServerResponse, root: string): Promise<void> {
    const url = new URL(request.url!, 'http://localhost');
    if (url.pathname === '/api/snapshot' && request.method === 'GET') return json(response, await snapshot(root));
    if (url.pathname === '/api/diff' && request.method === 'GET') return json(response, await review(root, url.searchParams.get('rev') || 'HEAD', await snapshot(root)));
    if (url.pathname === '/api/revisions' && request.method === 'GET') return json(response, await revisions(root));
    if (url.pathname === '/api/view' && request.method === 'GET') return json(response, readView(root));
    if (url.pathname === '/api/view' && request.method === 'PUT') {
        writeView(root, JSON.parse(await body(request)));
        return send(response, 204, '');
    }
    if (url.pathname === '/api/release' && request.method === 'GET') {
        const release = latestRelease(readReleases(root));
        return json(response, release ? { version: release.version, created: release.created } : null);
    }
    if (request.method !== 'GET') return send(response, 405, 'Method not allowed');
    const file = resolve(CLIENT, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
    if (!file.startsWith(CLIENT) || !existsSync(file)) return send(response, 404, 'Not found');
    // only Appling's own apps may embed the inspector: the VS Code extension's webview, locally or in the browser
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'content-security-policy': FRAME_ANCESTORS });
    response.end(readFileSync(file));
}

/** Only pages served by the inspector may talk to it: blocks other sites and DNS rebinding. */
function trusted(request: IncomingMessage, origins: string[]): boolean {
    const host = `http://${request.headers.host}`;
    const origin = request.headers.origin;
    return origins.includes(host) && (!origin || origins.includes(origin));
}

function body(request: IncomingMessage): Promise<string> {
    return new Promise((done, fail) => {
        const chunks: Buffer[] = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
        request.on('error', fail);
    });
}

function json(response: ServerResponse, value: unknown): void {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
}

function send(response: ServerResponse, status: number, text: string): void {
    response.writeHead(status, { 'content-type': 'text/plain' });
    response.end(text);
}

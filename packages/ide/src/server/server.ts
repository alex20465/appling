import { watch, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { basename, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startLanguageServer } from 'langium/lsp';
import { NodeFileSystem } from 'langium/node';
import { createConnection } from 'vscode-languageserver/node';
import { WebSocketMessageReader, WebSocketMessageWriter, type IWebSocket } from 'vscode-ws-jsonrpc';
import { WebSocketServer, type WebSocket } from 'ws';
import { createApplingLspServices } from '@appling/lang/lsp';
import { chat, createMcpServer, handleMcpRequest, languageModel, MemoryPlaybookStore, MemorySessionStore, modelSettings, touchedBy, type AppHost, type PlaybookStore, type SessionStore } from '@appling/ai';
import { applyEdit, latestRelease, readReleases, REFERENCES, type EditOperation } from '@appling/model';
import type { ModelMessage } from 'ai';
import type { Snapshot } from '../shared/snapshot.js';
import { fileDiff, review, revisions } from './git.js';
import { readView, snapshot, writeView } from './workspace.js';
import { ideHost, type ClientContext } from './sessions.js';
import { LiveTracker } from './live.js';
import { AgentViews } from './visuals.js';
import { playbookWorkspace, servePlaybook } from './playbook.js';
import { unseen, type LiveChanges } from '../shared/live.js';
import type { Decision } from '@appling/viz/protocol';

const CLIENT = fileURLToPath(new URL('../../dist/client/', import.meta.url));
const TYPES: Record<string, string> = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2', '.json': 'application/json', '.ttf': 'font/ttf'
};

export interface Ide {
    url: string;
    /** The repo's MCP server; agents reach it with a session's token as bearer token. */
    mcp: string;
    sessions: SessionStore;
    /** The workspace playbooks the sessions write and the client plays; also for the app's own chapters (`openChapter`). */
    playbooks: PlaybookStore;
    close(): Promise<void>;
}

export interface IdeOptions {
    /** Called with every snapshot the server pushes after a model file changed. */
    onSnapshot?(snapshot: Snapshot): void;
    /** Called with the files that have unsaved edits in any connected client (repo relative paths), after each change. */
    onUnsaved?(files: string[]): void;
    /** The agent sessions, shared by the repos of a workspace; default: a store of this server's own. */
    sessions?: SessionStore;
    /** What the app around the IDE adds to a session's context and does with its actions, such as Appling Desktop. */
    host?: AppHost;
    /** The workspace playbooks, shared like the sessions; default: a store of this server's own, in memory. */
    playbooks?: PlaybookStore;
    /** Called with the number of unseen model changes (changed files since the user last accepted) after each change. */
    onUnseen?(count: number): void;
}

/** Serves the IDE for one workspace folder on 127.0.0.1. */
export async function startIde(root: string, port = 0, options: IdeOptions = {}): Promise<Ide> {
    const events = new Set<WebSocket>();
    let origins: string[] = [];
    const sessions = options.sessions ?? new MemorySessionStore();
    const playbooks = options.playbooks ?? new MemoryPlaybookStore();
    const workspace = () => playbookWorkspace(root, options.host);
    const client: ClientContext = {};
    // the unsaved files each connected client reports, for Appling Desktop's rail
    const unsaved = new Map<WebSocket, string[]>();
    let reportedUnsaved = '[]';
    const reportUnsaved = () => {
        const files = [...new Set([...unsaved.values()].flat())].sort();
        if (JSON.stringify(files) === reportedUnsaved) return;
        reportedUnsaved = JSON.stringify(files);
        options.onUnsaved?.(files);
    };
    const broadcast = (message: unknown) => {
        const text = JSON.stringify(message);
        events.forEach(ws => ws.send(text));
    };
    const host = ideHost(root, client, () => events.size, broadcast, options.host);
    const views = new AgentViews(broadcast, client, () => events.size);
    let reported = 0;
    const live = new LiveTracker(root, state => {
        broadcast({ type: 'live', live: state });
        if (unseen(state) !== reported) options.onUnseen?.(reported = unseen(state));
    });
    const stopSessions = sessions.onChange(list => {
        broadcast({ type: 'sessions', sessions: list });
        views.prune(list.map(s => s.id));
    });
    // Only the playbook of the workspace this view shows goes to its clients.
    const stopPlaybooks = playbooks.onChange(async book => {
        if (events.size && book.workspace === await workspace()) broadcast({ type: 'playbook', playbook: book });
    });
    const agents: Agents = { live, views, sessions, host, playbooks };

    const server = createServer((request, response) => {
        if (!trusted(request, origins)) return send(response, 403, 'Forbidden');
        const work = request.url === '/mcp' ? serveMcp(request, response, root, agents)
            : request.url?.startsWith('/api/playbook') ? servePlaybook(request, response, playbooks, sessions, workspace, () => body(request))
            : request.url?.startsWith('/api/sessions') ? serveSessions(request, response, root, sessions)
            : request.url?.startsWith('/api/live/') || request.url?.startsWith('/api/proposals/') ? serveLive(request, response, live, views)
            : handle(request, response, root, live);
        work.catch(error => response.headersSent ? response.end() : send(response, 500, String(error)));
    });
    const sockets = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
        if (!trusted(request, origins)) return socket.destroy();
        sockets.handleUpgrade(request, socket, head, ws => {
            if (request.url === '/lsp') serveLanguage(ws, root);
            else if (request.url === '/events') {
                events.add(ws);
                ws.on('close', () => {
                    events.delete(ws);
                    if (unsaved.delete(ws)) reportUnsaved();
                });
                // The client reports what it shows, for the sessions' IDE context, and its unsaved files.
                ws.on('message', data => {
                    try {
                        const message = JSON.parse(data.toString()) as { type?: string, files?: unknown } & ClientContext;
                        if (message.type === 'context') Object.assign(client, { selection: message.selection, view: message.view, file: message.file, watching: message.watching });
                        if (message.type === 'unsaved' && Array.isArray(message.files)) {
                            unsaved.set(ws, message.files.filter((f): f is string => typeof f === 'string'));
                            reportUnsaved();
                        }
                    } catch {
                        // not JSON: ignored
                    }
                });
                sessions.list().then(list => ws.send(JSON.stringify({ type: 'sessions', sessions: list })), () => undefined);
                ws.send(JSON.stringify({ type: 'live', live: live.current() }));
                for (const view of views.all()) ws.send(JSON.stringify({ type: 'agent-view', view }));
                ws.send(JSON.stringify({ type: 'proposals', proposals: views.proposals() }));
                workspace().then(playbooks.read.bind(playbooks)).then(playbook => ws.send(JSON.stringify({ type: 'playbook', playbook })), () => undefined);
            } else ws.close();
        });
    });

    let timer: NodeJS.Timeout | undefined;
    const watcher = watch(root, { recursive: true }, (_, file) => {
        if (file !== REFERENCES && (!file?.endsWith('.appling') || file.split(sep).some(part => part.startsWith('.') || part === 'node_modules'))) return;
        clearTimeout(timer);
        timer = setTimeout(async () => {
            const current = await snapshot(root);
            const message = JSON.stringify({ type: 'snapshot', snapshot: current });
            events.forEach(ws => ws.send(message));
            options.onSnapshot?.(current);
            await live.update(current).catch(error => console.error(error));
        }, 100);
    });

    await new Promise<void>(done => server.listen(port, '127.0.0.1', done));
    const address = server.address() as { port: number };
    origins = [`http://127.0.0.1:${address.port}`, `http://localhost:${address.port}`];
    return {
        url: origins[0],
        mcp: `${origins[0]}/mcp`,
        sessions,
        playbooks,
        close: () => new Promise(done => {
            stopSessions();
            stopPlaybooks();
            watcher.close();
            clearTimeout(timer);
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
    playbooks: PlaybookStore;
}

/**
 * The repo's MCP server for one agent session, named by the bearer token of the request. Its visual tools draw on
 * this repo's canvas, and the files its tool calls write are attributed to it in the live changes.
 */
async function serveMcp(request: IncomingMessage, response: ServerResponse, root: string, { live, views, sessions, host, playbooks }: Agents): Promise<void> {
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
    await handleMcpRequest(createMcpServer(root, { session: { id, store: sessions, host, playbook: playbooks }, visualizer: views.host(id), onToolCall }), request, response);
}

/**
 * The live changes and the proposals: `POST /api/live/accept` (`{ paths? }`, every changed file without paths),
 * `POST /api/live/revert` (`{ path }`) and `POST /api/proposals/<id>` (`{ decision }`).
 */
async function serveLive(request: IncomingMessage, response: ServerResponse, live: LiveTracker, views: AgentViews): Promise<void> {
    if (request.method !== 'POST') return send(response, 405, 'Method not allowed');
    const url = new URL(request.url!, 'http://localhost');
    const input = JSON.parse(await body(request) || '{}') as { paths?: string[], path?: string, decision?: Decision };
    if (url.pathname === '/api/live/accept') return json(response, await live.acknowledge(input.paths) satisfies LiveChanges);
    if (url.pathname === '/api/live/revert') {
        const result = live.revert(String(input.path ?? ''));
        return result.ok ? json(response, result) : send(response, 400, result.reason!);
    }
    const id = decodeURIComponent(url.pathname.slice('/api/proposals/'.length));
    if (!input.decision || typeof input.decision.accepted !== 'boolean') return send(response, 400, 'A decision is required.');
    return views.decide(id, input.decision) ? json(response, { ok: true }) : send(response, 404, 'No such proposal is waiting.');
}

/**
 * The sessions for the IDE client and for an IDE server without Appling Desktop: list, open (returns the token and
 * the MCP URL once), rename or set the status as the user, end.
 */
async function serveSessions(request: IncomingMessage, response: ServerResponse, root: string, sessions: SessionStore): Promise<void> {
    const id = decodeURIComponent(request.url!.slice('/api/sessions'.length).replace(/^\//, ''));
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

async function handle(request: IncomingMessage, response: ServerResponse, root: string, live: LiveTracker): Promise<void> {
    const url = new URL(request.url!, 'http://localhost');
    if (url.pathname === '/api/snapshot' && request.method === 'GET') return json(response, await snapshot(root));
    if (url.pathname === '/api/diff' && request.method === 'GET') return json(response, await review(root, url.searchParams.get('rev') || 'HEAD', await snapshot(root)));
    if (url.pathname === '/api/diff/file' && request.method === 'GET') {
        const [rev, path] = [url.searchParams.get('rev') || 'HEAD', url.searchParams.get('path') ?? ''];
        return json(response, await fileDiff(root, rev, path, url.searchParams.get('before') ?? path).catch(error => ({ error: (error as Error).message })));
    }
    if (url.pathname === '/api/revisions' && request.method === 'GET') return json(response, await revisions(root));
    if (url.pathname === '/api/view' && request.method === 'GET') return json(response, readView(root));
    if (url.pathname === '/api/view' && request.method === 'PUT') {
        writeView(root, JSON.parse(await body(request)));
        return send(response, 204, '');
    }
    if (url.pathname === '/api/edit' && request.method === 'POST') {
        const { sources, operation } = JSON.parse(await body(request)) as { sources: Record<string, string>, operation: EditOperation };
        return json(response, await applyEdit(sources, operation, { release: latestRelease(readReleases(root)) }));
    }
    if (url.pathname === '/api/chat' && request.method === 'POST') {
        const { messages } = JSON.parse(await body(request)) as { messages: ModelMessage[] };
        response.writeHead(200, { 'content-type': 'application/x-ndjson' });
        for await (const event of chat(root, messages, languageModel(modelSettings(root)))) response.write(JSON.stringify(event) + '\n');
        response.end();
        return;
    }
    if (url.pathname === '/api/release' && request.method === 'GET') {
        const release = latestRelease(readReleases(root));
        return json(response, release ? { version: release.version, created: release.created } : null);
    }
    if (url.pathname === '/api/file' && request.method === 'PUT') {
        const file = resolve(root, url.searchParams.get('path') ?? '');
        if (!file.startsWith(resolve(root) + sep) || !file.endsWith('.appling')) return send(response, 400, 'Only .appling files inside the workspace can be written.');
        const text = await body(request);
        live.own(relative(root, file), text);
        writeFileSync(file, text);
        return send(response, 204, '');
    }
    if (request.method !== 'GET') return send(response, 405, 'Method not allowed');
    const file = resolve(CLIENT, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
    if (!file.startsWith(CLIENT) || !existsSync(file)) return send(response, 404, 'Not found');
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    response.end(readFileSync(file));
}

/**
 * One language server per editor connection, reading the workspace from disk and the open files from the
 * editor. Editors that do not name a workspace folder get this one, so references to unopened files resolve.
 */
function serveLanguage(ws: WebSocket, root: string): void {
    const folder = { uri: pathToFileURL(root).toString(), name: basename(root) };
    const socket: IWebSocket = {
        $type: 'IWebSocket',
        send: content => ws.send(content),
        onMessage: callback => ws.on('message', data => callback(withWorkspace(data.toString(), folder))),
        onError: callback => ws.on('error', callback),
        onClose: callback => ws.on('close', code => callback(code, '')),
        dispose: () => ws.close()
    };
    const connection = createConnection(new WebSocketMessageReader(socket), new WebSocketMessageWriter(socket));
    const realPath = (uri: { fsPath: string }) => existsSync(uri.fsPath) ? realpathSync(uri.fsPath) : uri.fsPath;
    startLanguageServer(createApplingLspServices({ connection, ...NodeFileSystem, realPath }).shared);
}

function withWorkspace(message: string, folder: { uri: string, name: string }): string {
    const parsed = JSON.parse(message) as { method?: string, params?: { rootUri?: string | null, workspaceFolders?: unknown[] | null } };
    if (parsed.method !== 'initialize' || parsed.params?.workspaceFolders?.length) return message;
    parsed.params = { ...parsed.params, rootUri: folder.uri, workspaceFolders: [folder] };
    return JSON.stringify(parsed);
}

/** Only pages served by this IDE may talk to it: blocks other sites and DNS rebinding. */
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

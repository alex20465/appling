import { watch, existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startLanguageServer } from 'langium/lsp';
import { NodeFileSystem } from 'langium/node';
import { createConnection } from 'vscode-languageserver/node';
import { WebSocketMessageReader, WebSocketMessageWriter, type IWebSocket } from 'vscode-ws-jsonrpc';
import { WebSocketServer, type WebSocket } from 'ws';
import { createApplingLspServices } from '@appling/lang/lsp';
import { addRequest, createMcpServer, handleMcpRequest, MemoryPlaybookStore, MemorySessionStore, removeRequest, REQUESTS, touchedBy, updateRequest, type AppHost, type PlaybookStore, type SessionStore } from '@appling/ai';
import { applyEdit, latestRelease, readReleases, REFERENCES, type EditOperation, type LineMark } from '@appling/model';
import { addTarget, CONFIG, GENERATIONS, readConfig, REGISTRY, STACKS, type Stack } from '@appling/codegen';
import type { Snapshot } from '../shared/snapshot.js';
import { fileDiff, review, revisions } from './git.js';
import { codeLinks, fileMarks, readView, snapshot, writeView } from './workspace.js';
import { GenerationRunner, parseSelection, type GenerationSpawner } from './generation.js';
import { playbookChapters, type PlaybookHook } from './generation-chapter.js';
import { ideHost, type ClientContext } from './sessions.js';
import { LiveTracker } from './live.js';
import { AgentViews } from './visuals.js';
import { playbookWorkspace, servePlaybook, viewWorkspace } from './playbook.js';
import { unseen, type LiveChanges } from '../shared/live.js';
import type { Decision } from '@appling/viz/protocol';

const CLIENT = fileURLToPath(new URL('../../dist/client/', import.meta.url));
// every ancestor counts: the webview's own frames (vscode-webview:) and the desktop workbench (vscode-file://vscode-app)
const FRAME_ANCESTORS = "frame-ancestors 'self' vscode-webview: vscode-file: https://*.vscode-cdn.net";
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
    /** Trusts one more origin from now on, such as where VS Code forwarded this server's port (`asExternalUri`). */
    trust(origin: string): void;
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
    /**
     * More origins to trust besides the server's own, such as `http://127.0.0.1:<port>` of a port forwarded to this
     * server from another machine (Appling Desktop's remote repos).
     */
    origins?: string[];
    /** Where generation runs go in the playbook; default: a chapter per run in `playbooks` (`playbookChapters`). */
    generationChapters?: PlaybookHook;
    /** Runs a generation; default: a worker thread (tests inject their own). */
    generate?: GenerationSpawner;
    /** Called with the implementation marks of the model files and the code references by file, after every snapshot (Appling Desktop's code view shows them). */
    onImplementation?(implementation: Implementation): void;
}

/** The implementation state for an editor: marks by model file and links from code back to elements, by absolute path. */
export interface Implementation {
    marks: Record<string, LineMark[]>;
    links: Record<string, { qn: string, start: number, end: number }[]>;
}

/** Serves the IDE for one workspace folder on 127.0.0.1. */
export async function startIde(root: string, port = 0, options: IdeOptions = {}): Promise<Ide> {
    const events = new Set<WebSocket>();
    let origins: string[] = [];
    const sessions = options.sessions ?? new MemorySessionStore();
    const playbooks = options.playbooks ?? new MemoryPlaybookStore();
    const workspace = (view?: string) => playbookWorkspace(root, options.host, view);
    // the workspace each connected view belongs to, as it reports it (see `ClientReport.workspace`)
    const viewsWorkspace = new Map<WebSocket, string | undefined>();
    // the workspace of the view that started the current generation run, for its playbook chapter
    let generationWorkspace: string | undefined;
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
    // Each view gets only the playbook of the workspace it belongs to.
    const stopPlaybooks = playbooks.onChange(async book => {
        if (!events.size) return;
        const text = JSON.stringify({ type: 'playbook', playbook: book });
        for (const ws of events) if (book.workspace === await workspace(viewsWorkspace.get(ws))) ws.send(text);
    });
    const agents: Agents = { live, views, sessions, host, playbooks };
    let refresh: () => void = () => undefined;
    const generation = new GenerationRunner(root, message => {
        broadcast(message);
        if ((message as { type: string, run?: { ended?: string } }).type === 'generation' && (message as { run: { ended?: string } }).run.ended) refresh();
    }, options.generationChapters ?? playbookChapters(playbooks, () => workspace(generationWorkspace), root), options.generate);

    const server = createServer((request, response) => {
        if (!trusted(request, origins)) return send(response, 403, 'Forbidden');
        const work = request.url === '/mcp' ? serveMcp(request, response, root, agents)
            : request.url?.startsWith('/api/playbook') ? servePlaybook(request, response, playbooks, sessions, workspace, () => body(request))
            : request.url?.startsWith('/api/sessions') ? serveSessions(request, response, root, sessions, views)
            : request.url?.startsWith('/api/live/') || request.url?.startsWith('/api/proposals/') ? serveLive(request, response, live, views)
            : request.url?.startsWith('/api/generat') || request.url?.startsWith('/api/code?') || request.url === '/api/targets' ? serveGeneration(request, response, root, generation, view => generationWorkspace = view)
            : handle(request, response, root, live);
        work.catch(error => response.headersSent ? response.end() : send(response, 500, String(error)));
    });
    const sockets = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
        if (!trusted(request, origins)) return socket.destroy();
        sockets.handleUpgrade(request, socket, head, ws => {
            const path = new URL(request.url!, 'http://localhost').pathname;
            if (request.url === '/lsp') serveLanguage(ws, root);
            else if (path === '/events') {
                events.add(ws);
                ws.on('close', () => {
                    events.delete(ws);
                    viewsWorkspace.delete(ws);
                    if (unsaved.delete(ws)) reportUnsaved();
                });
                // The client reports what it shows, for the sessions' IDE context, and its unsaved files.
                ws.on('message', data => {
                    try {
                        const message = JSON.parse(data.toString()) as { type?: string, files?: unknown, workspace?: unknown } & ClientContext;
                        if (message.type === 'context') {
                            Object.assign(client, { selection: message.selection, view: message.view, file: message.file, watching: message.watching });
                            const before = viewsWorkspace.get(ws);
                            viewsWorkspace.set(ws, viewWorkspace(message.workspace));
                            // a view that moved to another workspace gets that one's playbook
                            if (before !== viewsWorkspace.get(ws)) {
                                workspace(viewsWorkspace.get(ws)).then(playbooks.read.bind(playbooks)).then(playbook => ws.send(JSON.stringify({ type: 'playbook', playbook })), () => undefined);
                            }
                        }
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
                const named = viewWorkspace(new URL(request.url!, 'http://localhost').searchParams.get('workspace'));
                viewsWorkspace.set(ws, named);
                workspace(named).then(playbooks.read.bind(playbooks)).then(playbook => ws.send(JSON.stringify({ type: 'playbook', playbook })), () => undefined);
                const run = generation.current();
                if (run) ws.send(JSON.stringify({ type: 'generation', run }));
            } else ws.close();
        });
    });

    let timer: NodeJS.Timeout | undefined;
    /** Besides the model files: the config, the code references, the generation records and the targets' registries. */
    const state = () => [CONFIG, REFERENCES, GENERATIONS, REQUESTS, ...(readConfig(root).generate ?? []).map(t => relative(root, resolve(root, t.out, REGISTRY)))];
    const report = (current: Snapshot) => options.onImplementation?.({ marks: fileMarks(current), links: codeLinks(root, current) });
    refresh = () => {
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

    await new Promise<void>(done => server.listen(port, '127.0.0.1', done));
    const address = server.address() as { port: number };
    origins = [`http://127.0.0.1:${address.port}`, `http://localhost:${address.port}`, ...options.origins ?? []];
    return {
        url: origins[0],
        mcp: `${origins[0]}/mcp`,
        sessions,
        playbooks,
        trust: origin => {
            if (/^https?:\/\/[\w.-]+(:\d+)?$/.test(origin) && !origins.includes(origin)) origins.push(origin);
        },
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
 * Generation and the code it wrote: `POST /api/generate` (`{ selection }`, see `parseSelection`) starts a run and
 * answers 202 with it, 409 while one runs; `GET /api/generation` the current or last run; `GET /api/code?path=` the
 * text of a code file (read only) inside the workspace or a generate target, for the jump from an element to its code;
 * `POST /api/targets` (`{ stack }`, a key of `STACKS`) adds that stack's target to `appling.config.json`.
 */
async function serveGeneration(request: IncomingMessage, response: ServerResponse, root: string, runner: GenerationRunner, startedIn: (workspace?: string) => void): Promise<void> {
    const url = new URL(request.url!, 'http://localhost');
    if (url.pathname === '/api/generation' && request.method === 'GET') return json(response, runner.current() ?? null);
    if (url.pathname === '/api/generate' && request.method === 'POST') {
        const input = JSON.parse(await body(request) || '{}') as { selection?: unknown, workspace?: unknown };
        const selection = parseSelection(input.selection);
        if (!selection) return send(response, 400, 'A selection is required: { mode: "outstanding" | "all" } or { mode: "elements", elements: [...] }.');
        const outstanding = selection.mode === 'outstanding' ? Object.values((await snapshot(root)).implementation).filter(s => s.outstanding).length : undefined;
        if (!runner.current() || runner.current()!.ended) startedIn(viewWorkspace(input.workspace));
        const run = runner.start(selection, outstanding);
        if (!run) return send(response, 409, 'A generation is running.');
        response.writeHead(202, { 'content-type': 'application/json' });
        response.end(JSON.stringify(run));
        return;
    }
    if (url.pathname === '/api/targets' && request.method === 'POST') {
        const { stack } = JSON.parse(await body(request) || '{}') as { stack?: unknown };
        if (typeof stack !== 'string' || !Object.hasOwn(STACKS, stack)) return send(response, 400, `A stack is required: ${Object.keys(STACKS).join(', ')}.`);
        addTarget(root, stack as Stack, basename(root).replace(/\W/g, '_'));
        return json(response, readConfig(root).generate);
    }
    if (url.pathname === '/api/code' && request.method === 'GET') {
        const file = resolve(root, url.searchParams.get('path') ?? '');
        const folders = [root, ...(readConfig(root).generate ?? []).map(t => resolve(root, t.out))];
        const inside = folders.some(folder => {
            const rel = relative(folder, file);
            return rel && !rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('.git');
        });
        if (!inside || !existsSync(file) || !statSync(file).isFile()) return send(response, 404, 'No such code file in the workspace or a generate target.');
        if (statSync(file).size > 2 * 1024 * 1024) return send(response, 413, 'The file is too large to show.');
        return json(response, { path: relative(root, file), text: readFileSync(file, 'utf8') });
    }
    send(response, 405, 'Method not allowed');
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
 * the MCP URL once), rename or set the status as the user, end, and `POST /api/sessions/<id>/ask` (`{ text }`): a
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
    if (url.pathname === '/api/requests' && request.method === 'POST') {
        const { name, description, parent } = JSON.parse(await body(request)) as { name?: string, description?: string, parent?: string };
        if (!name?.trim()) return send(response, 400, 'A name is required.');
        return json(response, addRequest(root, { name: name.trim(), description: description?.trim() ?? '', parent }));
    }
    const requestId = url.pathname.match(/^\/api\/requests\/([\w-]+)$/)?.[1];
    if (requestId && request.method === 'PUT') {
        const { name, description } = JSON.parse(await body(request)) as { name?: string, description?: string };
        const updated = updateRequest(root, requestId, { ...name?.trim() ? { name: name.trim() } : {}, ...description !== undefined ? { description: description.trim() } : {} });
        return updated ? json(response, updated) : send(response, 404, 'No such request.');
    }
    if (requestId && request.method === 'DELETE') return removeRequest(root, requestId) ? send(response, 204, '') : send(response, 404, 'No such request.');
    if (url.pathname === '/api/edit' && request.method === 'POST') {
        const { sources, operation } = JSON.parse(await body(request)) as { sources: Record<string, string>, operation: EditOperation };
        return json(response, await applyEdit(sources, operation, { release: latestRelease(readReleases(root)) }));
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
    // only Appling's own apps may embed the IDE: the VS Code extension's webview, locally or in the browser
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'content-security-policy': FRAME_ANCESTORS });
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

import { watch, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLanguageServer } from 'langium/lsp';
import { NodeFileSystem } from 'langium/node';
import { createConnection } from 'vscode-languageserver/node';
import { WebSocketMessageReader, WebSocketMessageWriter, type IWebSocket } from 'vscode-ws-jsonrpc';
import { WebSocketServer, type WebSocket } from 'ws';
import { createApplingLspServices } from '@appling/lang/lsp';
import { chat, languageModel, modelSettings } from '@appling/ai';
import { applyEdit, latestRelease, readReleases, type EditOperation } from '@appling/model';
import type { ModelMessage } from 'ai';
import { readLayout, snapshot, writeLayout } from './workspace.js';

const CLIENT = fileURLToPath(new URL('../../dist/client/', import.meta.url));
const TYPES: Record<string, string> = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2', '.json': 'application/json', '.ttf': 'font/ttf'
};

export interface Ide {
    url: string;
    close(): Promise<void>;
}

/** Serves the IDE for one workspace folder on 127.0.0.1. */
export async function startIde(root: string, port = 0): Promise<Ide> {
    const events = new Set<WebSocket>();
    let origins: string[] = [];

    const server = createServer((request, response) => {
        if (!trusted(request, origins)) return send(response, 403, 'Forbidden');
        handle(request, response, root).catch(error => send(response, 500, String(error)));
    });
    const sockets = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
        if (!trusted(request, origins)) return socket.destroy();
        sockets.handleUpgrade(request, socket, head, ws => {
            if (request.url === '/lsp') serveLanguage(ws);
            else if (request.url === '/events') {
                events.add(ws);
                ws.on('close', () => events.delete(ws));
            } else ws.close();
        });
    });

    let timer: NodeJS.Timeout | undefined;
    const watcher = watch(root, { recursive: true }, (_, file) => {
        if (!file?.endsWith('.appling') || file.split(sep).some(part => part.startsWith('.') || part === 'node_modules')) return;
        clearTimeout(timer);
        timer = setTimeout(async () => {
            const message = JSON.stringify({ type: 'snapshot', snapshot: await snapshot(root) });
            events.forEach(ws => ws.send(message));
        }, 100);
    });

    await new Promise<void>(done => server.listen(port, '127.0.0.1', done));
    const address = server.address() as { port: number };
    origins = [`http://127.0.0.1:${address.port}`, `http://localhost:${address.port}`];
    return {
        url: origins[0],
        close: () => new Promise(done => {
            watcher.close();
            clearTimeout(timer);
            sockets.clients.forEach(ws => ws.terminate());
            server.close(() => done());
        })
    };
}

async function handle(request: IncomingMessage, response: ServerResponse, root: string): Promise<void> {
    const url = new URL(request.url!, 'http://localhost');
    if (url.pathname === '/api/snapshot' && request.method === 'GET') return json(response, await snapshot(root));
    if (url.pathname === '/api/layout' && request.method === 'GET') return json(response, readLayout(root));
    if (url.pathname === '/api/layout' && request.method === 'PUT') {
        writeLayout(root, JSON.parse(await body(request)));
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
        writeFileSync(file, await body(request));
        return send(response, 204, '');
    }
    if (request.method !== 'GET') return send(response, 405, 'Method not allowed');
    const file = resolve(CLIENT, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
    if (!file.startsWith(CLIENT) || !existsSync(file)) return send(response, 404, 'Not found');
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    response.end(readFileSync(file));
}

/** One language server per editor connection, reading the workspace from disk and the open files from the editor. */
function serveLanguage(ws: WebSocket): void {
    const socket: IWebSocket = {
        $type: 'IWebSocket',
        send: content => ws.send(content),
        onMessage: callback => ws.on('message', data => callback(data.toString())),
        onError: callback => ws.on('error', callback),
        onClose: callback => ws.on('close', code => callback(code, '')),
        dispose: () => ws.close()
    };
    const connection = createConnection(new WebSocketMessageReader(socket), new WebSocketMessageWriter(socket));
    startLanguageServer(createApplingLspServices({ connection, ...NodeFileSystem }).shared);
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

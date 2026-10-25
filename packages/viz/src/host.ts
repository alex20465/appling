import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Graph } from '@appling/model';
import type { Ask, Decision, HostMessage, Review, Show, WindowMessage } from './protocol.js';

const WINDOW = fileURLToPath(new URL('../dist/window/', import.meta.url));
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

/** A running window process, such as Electron's `ChildProcess`. */
export interface Launched {
    kill(): unknown;
    once(event: 'exit', listener: () => void): unknown;
}

export interface VisualizerOptions {
    root: string;
    graph(): Promise<Graph>;
    /** Starts the window on a URL; Electron by default. */
    launch?(url: string): Launched | Promise<Launched>;
}

export interface Selection {
    open: boolean;
    qn?: string;
    view?: Show;
}

/**
 * The floating window next to a Claude Code session: shows views of the model, reports what the person selects,
 * forwards their questions and waits for their decision on proposed changes. It starts on first use.
 */
export class Visualizer {
    private server?: { http: Server, sockets: WebSocketServer, watcher: FSWatcher, url: string };
    private window?: Launched;
    private current?: Show;
    private selected?: string;
    private readonly clients = new Set<WebSocket>();
    private readonly reviews = new Map<string, { review: Review, resolve(decision: Decision): void }>();
    private readonly askListeners: ((ask: Ask) => void)[] = [];

    constructor(private readonly options: VisualizerOptions) {}

    async show(show: Show): Promise<void> {
        this.current = show;
        this.selected = undefined;
        await this.open();
        this.broadcast({ type: 'show', show });
    }

    selection(): Selection {
        return { open: !!this.window, qn: this.selected, view: this.current };
    }

    /** Posts an answer into the window's thread; false when the window is closed. */
    reply(text: string, askId?: string): boolean {
        if (!this.window) return false;
        this.broadcast({ type: 'reply', text, askId });
        return true;
    }

    /** Shows a proposal and resolves with the person's decision; closing the window rejects it. */
    async review(review: Review): Promise<Decision> {
        await this.open();
        const id = randomUUID();
        const decision = new Promise<Decision>(resolve => this.reviews.set(id, { review, resolve }));
        this.broadcast({ type: 'review', id, review });
        return decision;
    }

    onAsk(listener: (ask: Ask) => void): void {
        this.askListeners.push(listener);
    }

    async close(): Promise<void> {
        this.window?.kill();
        if (!this.server) return;
        const { http, sockets, watcher } = this.server;
        this.server = undefined;
        watcher.close();
        sockets.clients.forEach(ws => ws.terminate());
        await new Promise(done => http.close(done));
    }

    private async open(): Promise<void> {
        const server = this.server ?? await this.start();
        if (this.window) return;
        const launched = await (this.options.launch ?? electron)(server.url);
        this.window = launched;
        launched.once('exit', () => {
            if (this.window !== launched) return;
            this.window = undefined;
            for (const [id, pending] of this.reviews) {
                this.reviews.delete(id);
                pending.resolve({ accepted: false, comment: 'The window was closed.' });
            }
        });
    }

    private async start(): Promise<NonNullable<Visualizer['server']>> {
        const token = randomBytes(16).toString('hex');
        let origins: string[] = [];
        const http = createServer((request, response) => {
            if (!trusted(request, origins)) return response.writeHead(403).end();
            const path = new URL(request.url!, 'http://localhost').pathname;
            const file = resolve(WINDOW, `.${path === '/' ? '/index.html' : path}`);
            if (!file.startsWith(WINDOW) || !existsSync(file)) return response.writeHead(404).end();
            response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
        });
        const sockets = new WebSocketServer({ noServer: true });
        http.on('upgrade', (request, socket, head) => {
            if (!trusted(request, origins) || request.url !== `/events?token=${token}`) return socket.destroy();
            sockets.handleUpgrade(request, socket, head, ws => this.connect(ws));
        });
        let timer: NodeJS.Timeout | undefined;
        const watcher = watch(this.options.root, { recursive: true }, (_, file) => {
            if (!file?.endsWith('.appling') || file.split(sep).some(part => part.startsWith('.') || part === 'node_modules')) return;
            clearTimeout(timer);
            timer = setTimeout(async () => this.broadcast({ type: 'graph', graph: await this.options.graph() }), 100);
        });
        await new Promise<void>(done => http.listen(0, '127.0.0.1', done));
        const port = (http.address() as { port: number }).port;
        origins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
        process.once('exit', () => this.window?.kill());
        this.server = { http, sockets, watcher, url: `${origins[0]}/?token=${token}` };
        return this.server;
    }

    private async connect(ws: WebSocket): Promise<void> {
        this.clients.add(ws);
        ws.on('close', () => this.clients.delete(ws));
        ws.on('message', data => this.receive(JSON.parse(data.toString()) as WindowMessage));
        const send = (message: HostMessage) => ws.send(JSON.stringify(message));
        send({ type: 'graph', graph: await this.options.graph() });
        if (this.current) send({ type: 'show', show: this.current });
        for (const [id, { review }] of this.reviews) send({ type: 'review', id, review });
    }

    private receive(message: WindowMessage): void {
        if (message.type === 'select') {
            this.selected = message.qn;
            this.current = message.view;
        } else if (message.type === 'ask') {
            const ask = { id: randomUUID().slice(0, 8), text: message.text, selected: this.selected, view: this.current };
            this.askListeners.forEach(listener => listener(ask));
        } else {
            const pending = this.reviews.get(message.id);
            if (!pending) return;
            this.reviews.delete(message.id);
            pending.resolve(message.decision);
            this.broadcast({ type: 'reviewed', id: message.id });
        }
    }

    private broadcast(message: HostMessage): void {
        const text = JSON.stringify(message);
        this.clients.forEach(ws => ws.send(text));
    }
}

/** Starts Electron on the window; through XWayland on Linux Wayland sessions, which forbid always on top windows. */
function electron(url: string): Launched {
    const require = createRequire(import.meta.url);
    // Electron downloads its binary on first use and reports that on stdout, which carries the MCP protocol here.
    spawnSync(process.execPath, ['-e', 'require(process.argv[1])', require.resolve('electron')], { stdio: ['ignore', 2, 2] });
    const binary = require('electron') as string;
    const main = fileURLToPath(new URL('./main/electron.js', import.meta.url));
    const wayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    return spawn(binary, [...(wayland ? ['--ozone-platform=x11'] : []), main, url, String(process.pid)], { stdio: 'ignore', env });
}

/** Only the window this host served may connect: blocks other sites and DNS rebinding. */
function trusted(request: IncomingMessage, origins: string[]): boolean {
    const origin = request.headers.origin;
    return origins.includes(`http://${request.headers.host}`) && (!origin || origins.includes(origin));
}

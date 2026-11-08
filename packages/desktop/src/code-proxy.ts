import { randomBytes } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server } from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';

/** The cookie the Desktop's code views send to the proxy (set in their session before they load). */
export const PROXY_COOKIE = 'appling-code';
/** Code OSS's connection token cookie. */
const TOKEN_COOKIE = 'vscode-tkn';

/** Where the proxy sends a repo's requests: its instance's port and connection token. */
export interface CodeTarget {
    port: number;
    token: string;
}

export interface CodeProxyOptions {
    /** The secret of the proxy cookie; random by default. */
    secret?: string;
    /** Upgrades of `/bridge` (the Appling extension's channel, see `code-bridge.ts`); they authenticate on their own. */
    bridge?(request: IncomingMessage, socket: Duplex, head: Buffer): void;
}

/** The base path of a repo's instance, also passed to it as `--server-base-path`. */
export function basePath(key: string): string {
    return `/r/${key}`;
}

/** The repo key and the rest of a proxied path: `/r/<key>/...`. */
export function routeOf(path: string): string | undefined {
    return /^\/r\/([A-Za-z0-9_-]+)(?:[/?]|$)/.exec(path)?.[1];
}

/** The cookie header with our cookie and any connection token removed, and the instance's token added. */
export function rewriteCookies(header: string | undefined, token: string): string {
    const kept = (header ?? '').split(';').map(c => c.trim()).filter(c => c && !c.startsWith(`${PROXY_COOKIE}=`) && !c.startsWith(`${TOKEN_COOKIE}=`));
    return [...kept, `${TOKEN_COOKIE}=${token}`].join('; ');
}

/** Whether the request carries the proxy cookie with the secret. */
export function authorized(header: string | undefined, secret: string): boolean {
    return (header ?? '').split(';').some(c => c.trim() === `${PROXY_COOKIE}=${secret}`);
}

/**
 * One local HTTP and websocket proxy in front of every repo's Code OSS instance, on a port kept across starts.
 *
 * Code OSS keeps user settings, keybindings and UI state in the browser's IndexedDB, which is per origin, so every
 * instance is served from this one origin (`/r/<key>/` each, the instance's `--server-base-path`): settings and
 * keybindings are shared, while each repo's workspace state stays its own (keyed by its folder). The proxy admits
 * only requests with its cookie and adds each instance's own connection token, which the browser never sees.
 */
export class CodeProxy {
    readonly secret: string;
    private readonly targets = new Map<string, CodeTarget>();
    private server?: Server;
    /** The port it listens on (0 before `listen`). */
    port = 0;
    /** Upgraded connections, which the server no longer tracks. */
    private readonly upgraded = new Set<Duplex>();

    constructor(private readonly options: CodeProxyOptions = {}) {
        this.secret = options.secret ?? randomBytes(24).toString('base64url');
    }

    /** Listens on 127.0.0.1, on the preferred port when it is free (so the origin and its storage stay), else on any. */
    async listen(preferred = 0): Promise<number> {
        const server = createServer((request, response) => {
            const target = this.admit(request);
            if (typeof target === 'number') {
                response.writeHead(target, { 'content-type': 'text/plain' }).end(target === 503 ? 'This code view is suspended.' : 'Forbidden');
                return;
            }
            const upstream = httpRequest({
                host: '127.0.0.1', port: target.port, method: request.method, path: request.url,
                headers: this.headers(request.headers, target)
            }, reply => {
                const headers = { ...reply.headers };
                const cookies = (headers['set-cookie'] ?? []).filter(c => !c.startsWith(`${TOKEN_COOKIE}=`));
                if (cookies.length) headers['set-cookie'] = cookies;
                else delete headers['set-cookie'];
                response.writeHead(reply.statusCode ?? 502, reply.statusMessage, headers);
                reply.pipe(response);
            });
            upstream.on('error', () => {
                if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' });
                response.end('The code view did not answer.');
            });
            request.pipe(upstream);
        });
        server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
            socket.on('error', () => socket.destroy());
            this.upgraded.add(socket);
            socket.on('close', () => this.upgraded.delete(socket));
            if (request.url?.split('?')[0] === '/bridge') {
                if (this.options.bridge) return this.options.bridge(request, socket, head);
                return socket.destroy();
            }
            const target = this.admit(request);
            if (typeof target === 'number') {
                socket.end(`HTTP/1.1 ${target} ${target === 503 ? 'Service Unavailable' : 'Forbidden'}\r\nConnection: close\r\n\r\n`);
                return;
            }
            const upstream = connect(target.port, '127.0.0.1', () => {
                const headers = this.headers(request.headers, target);
                const lines = [`${request.method} ${request.url} HTTP/1.1`];
                for (const [name, value] of Object.entries(headers)) {
                    for (const v of Array.isArray(value) ? value : [value]) if (v !== undefined) lines.push(`${name}: ${v}`);
                }
                upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
                if (head.length) upstream.write(head);
                upstream.pipe(socket).pipe(upstream);
            });
            upstream.on('error', () => socket.destroy());
            socket.on('close', () => upstream.destroy());
            upstream.on('close', () => socket.destroy());
        });
        this.server = server;
        this.port = await new Promise<number>((resolve, reject) => {
            const attempt = (port: number) => {
                server.once('error', (error: NodeJS.ErrnoException) => {
                    if (port && error.code === 'EADDRINUSE') attempt(0);
                    else reject(error);
                });
                server.listen(port, '127.0.0.1', () => {
                    server.removeAllListeners('error');
                    resolve((server.address() as { port: number }).port);
                });
            };
            attempt(preferred);
        });
        return this.port;
    }

    get origin(): string {
        return `http://127.0.0.1:${this.port}`;
    }

    /** The page of a repo's code view, opening its folder. */
    url(key: string, folder: string): string {
        return `${this.origin}${basePath(key)}/?folder=${encodeURIComponent(folder)}`;
    }

    /** The bridge's websocket URL, for the instances' environment. */
    get bridgeUrl(): string {
        return `ws://127.0.0.1:${this.port}/bridge`;
    }

    /** Routes a repo key to its running instance, or (undefined) answers its requests as suspended. */
    route(key: string, target: CodeTarget | undefined): void {
        if (target) this.targets.set(key, target);
        else this.targets.delete(key);
    }

    private admit(request: IncomingMessage): CodeTarget | 403 | 503 {
        if (!authorized(request.headers.cookie, this.secret)) return 403;
        const key = routeOf(request.url ?? '');
        if (!key) return 403;
        return this.targets.get(key) ?? 503;
    }

    private headers(headers: IncomingHttpHeaders, target: CodeTarget): IncomingHttpHeaders {
        return { ...headers, cookie: rewriteCookies(headers.cookie, target.token) };
    }

    close(): Promise<void> {
        return new Promise(resolve => {
            if (!this.server) return resolve();
            this.server.closeAllConnections();
            for (const socket of this.upgraded) socket.destroy();
            this.server.close(() => resolve());
        });
    }
}

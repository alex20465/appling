import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface GatewayOptions {
    /** The session a bearer token belongs to. */
    authenticate(token: string): Promise<string | undefined>;
    /** The MCP endpoint of the IDE server of the session's repo; undefined while that server is not up. */
    target(session: string): string | undefined;
    /** A hook event an agent posted (`/hooks/<event>`), with its JSON body. */
    onHook(session: string, event: string, body: unknown): void;
}

const MAX_HOOK_BODY = 1024 * 1024;

/**
 * The one local endpoint every agent session talks to (#10): `/mcp` forwards to the MCP server of the session's
 * repo (the IDE server, whose port changes with every start) and `/hooks/<event>` takes the agents' hook events.
 * Its own port is kept between starts (`listen(port)`), so an agent that kept running in the pty host while the app
 * restarted still reaches both. Binds 127.0.0.1, checks the Host header, refuses browser requests (any Origin) and
 * needs a session's bearer token on every request.
 */
export class Gateway {
    private server?: Server;
    port?: number;

    constructor(private readonly options: GatewayOptions) {}

    get mcpUrl(): string {
        return `http://127.0.0.1:${this.port}/mcp`;
    }

    get hookUrl(): string {
        return `http://127.0.0.1:${this.port}/hooks`;
    }

    /** Listens on the given port, else (taken, or none given) on a free one; resolves with the port. */
    async listen(port = 0): Promise<number> {
        const server = createServer((req, res) => void this.handle(req, res).catch(() => {
            if (!res.headersSent) res.writeHead(500);
            res.end();
        }));
        const bind = (p: number) => new Promise<number>((resolve, reject) => {
            const failed = (error: Error) => reject(error);
            server.once('error', failed);
            server.listen(p, '127.0.0.1', () => {
                server.off('error', failed);
                resolve((server.address() as AddressInfo).port);
            });
        });
        this.port = await bind(port).catch((error: NodeJS.ErrnoException): Promise<number> => port && error.code === "EADDRINUSE" ? bind(0) : Promise.reject(error));
        this.server = server;
        return this.port;
    }

    close(): void {
        this.server?.closeAllConnections();
        this.server?.close();
        this.server = undefined;
    }

    private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const host = req.headers.host;
        if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return deny(res, 403, 'Unknown host');
        if (req.headers.origin !== undefined) return deny(res, 403, 'No browser requests');
        const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
        const session = token ? await this.options.authenticate(token) : undefined;
        if (!session) return deny(res, 401, 'Unknown session');
        const url = new URL(req.url ?? '/', `http://${host}`);
        const hook = /^\/hooks\/([\w.:-]+)$/.exec(url.pathname);
        if (hook) {
            if (req.method !== 'POST') return deny(res, 405, 'POST only');
            const body = await readBody(req, MAX_HOOK_BODY);
            if (body === undefined) return deny(res, 413, 'Too large');
            let value: unknown = {};
            try {
                value = body.trim() ? JSON.parse(body) : {};
            } catch {
                // a hook without JSON still tells its event
            }
            this.options.onHook(session, hook[1], value);
            // an empty 2xx answer: no decision, the agent goes on as without the hook
            res.writeHead(200);
            return void res.end();
        }
        if (url.pathname !== '/mcp') return deny(res, 404, 'Not found');
        const target = this.options.target(session);
        if (!target) return deny(res, 503, 'The repo\'s IDE server is not running');
        this.forward(req, res, new URL(target));
    }

    private forward(req: IncomingMessage, res: ServerResponse, target: URL): void {
        const headers = { ...req.headers, host: target.host };
        delete headers.connection;
        const upstream = request(target, { method: req.method, headers }, answer => {
            res.writeHead(answer.statusCode ?? 502, answer.headers);
            answer.pipe(res);
        });
        upstream.on('error', () => deny(res, 502, 'The repo\'s IDE server did not answer'));
        res.on('close', () => upstream.destroy());
        req.pipe(upstream);
    }
}

function deny(res: ServerResponse, status: number, message: string): void {
    if (res.headersSent) return void res.end();
    res.writeHead(status, { 'content-type': 'text/plain' });
    res.end(message);
}

function readBody(req: IncomingMessage, limit: number): Promise<string | undefined> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > limit) {
                resolve(undefined);
                req.destroy();
            } else chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';

/**
 * The channel between the Appling extension inside a repo's Code OSS instance and the Desktop main process
 * (decision 8A: the bridge lives in `appling-vscode`). The instance gets the bridge's URL and its own token in
 * `APPLING_DESKTOP_BRIDGE` and `APPLING_DESKTOP_TOKEN`; the extension host inherits them. One JSON message per frame.
 */
export type ExtensionMessage =
    /** The first message: the token says which repo the extension runs in. */
    | { type: 'hello', token: string }
    /** The cursor moved in a `.appling` file. */
    | { type: 'cursor', uri: string, offset: number };

export type DesktopMessage =
    /** The token was accepted. */
    | { type: 'welcome' }
    /** Open a file and put the cursor on an element's source, from `start` to `end` (offsets in the text). */
    | { type: 'reveal', uri: string, start: number, end: number };

export const BRIDGE_ENV = 'APPLING_DESKTOP_BRIDGE';
export const TOKEN_ENV = 'APPLING_DESKTOP_TOKEN';

/** Parses a message from the extension; anything else is undefined. */
export function parseExtensionMessage(data: string): ExtensionMessage | undefined {
    let message: unknown;
    try {
        message = JSON.parse(data);
    } catch {
        return undefined;
    }
    if (!message || typeof message !== 'object') return undefined;
    const m = message as Record<string, unknown>;
    if (m.type === 'hello' && typeof m.token === 'string') return { type: 'hello', token: m.token };
    if (m.type === 'cursor' && typeof m.uri === 'string' && Number.isInteger(m.offset) && (m.offset as number) >= 0) {
        return { type: 'cursor', uri: m.uri, offset: m.offset as number };
    }
    return undefined;
}

export interface CodeBridgeOptions {
    /** The cursor moved in a `.appling` file of a repo's code view. */
    onCursor(repo: string, uri: string, offset: number): void;
    /** How long a connection may take to say hello. */
    helloTimeout?: number;
}

/**
 * The Desktop side of the bridge: hands out a token per repo, accepts websocket connections (upgrades routed to it by
 * the code proxy), lets each speak only for the repo of its token, and reveals sources in a repo's extension.
 */
export class CodeBridge {
    private readonly server = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
    private readonly tokens = new Map<string, string>();
    private readonly sockets = new Map<string, Set<WebSocket>>();

    constructor(private readonly options: CodeBridgeOptions) { }

    /** A new token for a repo (each instance start gets one); earlier tokens of the repo stop working. */
    token(repo: string): string {
        this.revoke(repo);
        const token = randomBytes(24).toString('base64url');
        this.tokens.set(token, repo);
        return token;
    }

    /** Forgets a repo's token and closes its connections. */
    revoke(repo: string): void {
        for (const [token, owner] of this.tokens) if (owner === repo) this.tokens.delete(token);
        for (const socket of this.sockets.get(repo) ?? []) socket.close();
        this.sockets.delete(repo);
    }

    /** Whether the repo's extension is connected. */
    connected(repo: string): boolean {
        return (this.sockets.get(repo)?.size ?? 0) > 0;
    }

    /** Sends a reveal to the repo's extension; false when none is connected. */
    reveal(repo: string, uri: string, start: number, end: number): boolean {
        const sockets = this.sockets.get(repo);
        if (!sockets?.size) return false;
        const message = JSON.stringify({ type: 'reveal', uri, start, end } satisfies DesktopMessage);
        for (const socket of sockets) socket.send(message);
        return true;
    }

    /** Takes over an HTTP upgrade request. */
    upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
        this.server.handleUpgrade(request, socket, head, ws => this.accept(ws));
    }

    private accept(ws: WebSocket): void {
        let repo: string | undefined;
        const timer = setTimeout(() => ws.close(4001, 'no hello'), this.options.helloTimeout ?? 10000);
        ws.on('message', data => {
            const message = parseExtensionMessage(data.toString());
            if (!repo) {
                const owner = message?.type === 'hello' ? this.tokens.get(message.token) : undefined;
                clearTimeout(timer);
                if (!owner) return ws.close(4003, 'unknown token');
                repo = owner;
                if (!this.sockets.has(repo)) this.sockets.set(repo, new Set());
                this.sockets.get(repo)!.add(ws);
                ws.send(JSON.stringify({ type: 'welcome' } satisfies DesktopMessage));
            } else if (message?.type === 'cursor') this.options.onCursor(repo, message.uri, message.offset);
        });
        ws.on('close', () => {
            clearTimeout(timer);
            if (repo) this.sockets.get(repo)?.delete(ws);
        });
        ws.on('error', () => ws.terminate());
    }

    close(): void {
        for (const sockets of this.sockets.values()) for (const socket of sockets) socket.terminate();
        this.sockets.clear();
        this.tokens.clear();
        this.server.close();
    }
}

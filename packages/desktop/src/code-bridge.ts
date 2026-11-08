import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import * as nativePath from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { CodeMarks } from './ide-process.js';

/**
 * The channel between the Appling extension inside a repo's Code OSS instance and the Desktop main process
 * (decision 8A: the bridge lives in `appling-vscode`). The instance gets the bridge's URL and its own token in
 * `APPLING_DESKTOP_BRIDGE` and `APPLING_DESKTOP_TOKEN`; the extension host inherits them. One JSON message per frame.
 */
export type ExtensionMessage =
    /** The first message: the token says which repo the extension runs in. */
    | { type: 'hello', token: string }
    /** The cursor moved in a `.appling` file. */
    | { type: 'cursor', uri: string, offset: number }
    /** Show an element on the canvas: the extension's CodeLens on code that implements it. */
    | { type: 'element', qn: string };

export type DesktopMessage =
    /** The token was accepted. */
    | { type: 'welcome' }
    /** Open a file and put the cursor on an element's source, from `start` to `end` (offsets in the text). */
    | { type: 'reveal', uri: string, start: number, end: number }
    /**
     * Open the diff editor of a file between a git revision and the working tree: `before` is the file's absolute path
     * at `rev` (it differs after a rename), `path` its absolute path now; `line` (from 1) is revealed.
     */
    | { type: 'diff', path: string, before: string, rev: string, line?: number }
    /**
     * The implementation state for the editor (#20): gutter marks of the model files' lines and links from code back to
     * the elements it implements, both by absolute path. Each replaces the last; a new connection gets the last one.
     */
    | { type: 'implementation', marks: CodeMarks['marks'], links: CodeMarks['links'] }
    /** Open a code file at a line range (from 1): the jump from an element to its code. */
    | { type: 'open', path: string, start: number, end: number };

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
    if (m.type === 'element' && typeof m.qn === 'string' && /^[\w.]+$/.test(m.qn)) return { type: 'element', qn: m.qn };
    return undefined;
}

/** The IDE's request for a text diff (`TextDiffRequest` of `@appling/ide`): paths relative to the repo. */
export interface TextDiffRequest {
    path: string;
    before?: string;
    rev: string;
    line?: number;
}

/** The path functions of the machine a repo's files are on: this one's, or POSIX ones for a remote repo. */
export type PathFunctions = Pick<typeof nativePath, 'dirname' | 'isAbsolute' | 'relative' | 'resolve'>;

/**
 * The diff message for a repo's extension; undefined unless both paths stay inside the repo and the revision is plain.
 * `repo` is the repo's folder where its code view runs: for a remote repo its folder on that machine, with
 * `path.posix` as `path`, so the extension there gets that machine's absolute paths.
 */
export function diffMessage(repo: string, request: TextDiffRequest, path: PathFunctions = nativePath): DesktopMessage | undefined {
    const { isAbsolute, relative, resolve } = path;
    if (!request || typeof request.path !== 'string' || typeof request.rev !== 'string') return undefined;
    // a revision, never an option for git
    if (!/^[\w./~^@{}:-]+$/.test(request.rev) || request.rev.startsWith('-')) return undefined;
    const inside = (file: string) => {
        const absolute = resolve(repo, file);
        const rel = relative(repo, absolute);
        return rel && !rel.startsWith('..') && !isAbsolute(rel) ? absolute : undefined;
    };
    const now = inside(request.path);
    const before = inside(typeof request.before === 'string' ? request.before : request.path);
    if (!now || !before) return undefined;
    const line = Number.isInteger(request.line) && request.line! > 0 ? request.line : undefined;
    return { type: 'diff', path: now, before, rev: request.rev, ...(line ? { line } : {}) };
}

/**
 * The open message for a repo's extension; undefined unless the file stays inside the repo and the lines are plain.
 * The IDE names the file relative to the repo, or by the absolute path its server sees; `repo` and `path` as for
 * `diffMessage`.
 */
export function openMessage(repo: string, request: { path: string, start: number, end?: number }, path: PathFunctions = nativePath): DesktopMessage | undefined {
    if (!request || typeof request.path !== 'string' || !Number.isInteger(request.start) || request.start < 1) return undefined;
    const { dirname, isAbsolute, relative, resolve } = path;
    const file = resolve(repo, request.path);
    const rel = relative(repo, file);
    // generated projects may live next to the repo (`"out": "../app"`), so only the parent of the repo is allowed besides it
    const parent = relative(dirname(repo), file);
    if (!rel || isAbsolute(rel) || parent.startsWith('..') || isAbsolute(parent)) return undefined;
    const end = Number.isInteger(request.end) && request.end! >= request.start ? request.end! : request.start;
    return { type: 'open', path: file, start: request.start, end };
}

export interface CodeBridgeOptions {
    /** The cursor moved in a `.appling` file of a repo's code view. */
    onCursor(repo: string, uri: string, offset: number): void;
    /** The extension asked to show an element of the repo's model. */
    onElement?(repo: string, qn: string): void;
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
    /** Messages for a repo whose extension is not connected yet, sent when it says hello. */
    private readonly queued = new Map<string, DesktopMessage[]>();
    /** The last implementation state per repo, for connections that come later. */
    private readonly implementations = new Map<string, DesktopMessage>();

    constructor(private readonly options: CodeBridgeOptions) { }

    /** A new token for a repo (each instance start gets one); earlier tokens of the repo stop working. */
    token(repo: string): string {
        this.disconnect(repo);
        const token = randomBytes(24).toString('base64url');
        this.tokens.set(token, repo);
        return token;
    }

    /** Forgets a repo's token, closes its connections and drops what was waiting for them. */
    revoke(repo: string): void {
        this.disconnect(repo);
        this.queued.delete(repo);
    }

    /** Sends the repo's implementation state to its extension now and to every later connection. */
    implementation(repo: string, state: CodeMarks): void {
        const message: DesktopMessage = { type: 'implementation', marks: state.marks, links: state.links };
        this.implementations.set(repo, message);
        for (const socket of this.sockets.get(repo) ?? []) socket.send(JSON.stringify(message));
    }

    /** Forgets a repo's tokens and closes its connections; queued messages wait for the next one. */
    private disconnect(repo: string): void {
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

    /** Sends a message to the repo's extension, or keeps it until the extension connects (the code view is starting). */
    send(repo: string, message: DesktopMessage): void {
        const sockets = this.sockets.get(repo);
        if (!sockets?.size) {
            this.queued.set(repo, [...(this.queued.get(repo) ?? []), message].slice(-10));
            return;
        }
        for (const socket of sockets) socket.send(JSON.stringify(message));
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
                const implementation = this.implementations.get(repo);
                if (implementation) ws.send(JSON.stringify(implementation));
                for (const queued of this.queued.get(repo) ?? []) ws.send(JSON.stringify(queued));
                this.queued.delete(repo);
            } else if (message?.type === 'cursor') this.options.onCursor(repo, message.uri, message.offset);
            else if (message?.type === 'element') this.options.onElement?.(repo, message.qn);
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

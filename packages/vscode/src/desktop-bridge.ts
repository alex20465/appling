/**
 * The Appling Desktop bridge (decision 8A of epic #15): inside a repo's code view (Code OSS started by Appling Desktop)
 * the extension connects to the Desktop main process, reports the cursor in `.appling` files, so the canvas selects
 * the element there, opens the source of the element selected on the canvas and opens the Review tab's text diffs. Desktop passes the channel in
 * `APPLING_DESKTOP_BRIDGE` (a websocket URL on 127.0.0.1) and `APPLING_DESKTOP_TOKEN`; without them nothing runs.
 * The messages mirror `packages/desktop/src/code-bridge.ts`.
 */

/** What the bridge needs from the editor, so it runs (and is tested) without VS Code. */
export interface BridgeEditor {
    /** Calls back with the URI and offset of the cursor in a `.appling` file whenever it moves. */
    onCursor(listener: (uri: string, offset: number) => void): { dispose(): void };
    /** Opens a file and puts the cursor at `start`, showing `start` to `end`. */
    reveal(uri: string, start: number, end: number): Promise<void> | void;
    /** Opens the diff editor of a file between a git revision (`before`, its absolute path then) and now (`path`). */
    diff(path: string, before: string, rev: string, line?: number): Promise<void> | void;
}

export interface BridgeOptions {
    url: string;
    token: string;
    editor: BridgeEditor;
    /** Debounce of cursor reports. */
    debounce?: number;
    /** The pause before reconnecting after the channel closed; it doubles up to 30 seconds. */
    retry?: number;
    WebSocket?: typeof WebSocket;
    log?(message: string): void;
}

export interface Bridge {
    /** Resolves when Desktop accepted the token (again after each reconnect). */
    readonly welcomed: Promise<void>;
    dispose(): void;
}

/** Connects to Desktop and keeps the connection, reconnecting after it drops (Desktop rejecting the token ends it). */
export function connectDesktop(options: BridgeOptions): Bridge {
    const Socket = options.WebSocket ?? globalThis.WebSocket;
    const debounce = options.debounce ?? 150;
    let socket: WebSocket | undefined;
    let disposed = false;
    let wait = options.retry ?? 1000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: ReturnType<typeof setTimeout> | undefined;
    /** The position just revealed, so the cursor it moves is not reported back. */
    let revealed: string | undefined;
    let welcome!: () => void;
    const bridge: { welcomed: Promise<void>, dispose(): void } = {
        welcomed: new Promise(resolve => welcome = resolve),
        dispose() {
            disposed = true;
            clearTimeout(timer);
            clearTimeout(pending);
            cursor.dispose();
            socket?.close();
        }
    };

    const cursor = options.editor.onCursor((uri, offset) => {
        clearTimeout(pending);
        pending = setTimeout(() => {
            if (revealed === `${uri}#${offset}`) return;
            revealed = undefined;
            if (socket?.readyState === Socket.OPEN) socket.send(JSON.stringify({ type: 'cursor', uri, offset }));
        }, debounce);
    });

    const open = () => {
        if (disposed) return;
        const ws = new Socket(options.url);
        socket = ws;
        ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', token: options.token }));
        ws.onmessage = event => {
            let message: { type?: string, uri?: unknown, start?: unknown, end?: unknown, path?: unknown, before?: unknown, rev?: unknown, line?: unknown };
            try {
                message = JSON.parse(String(event.data));
            } catch {
                return;
            }
            if (message.type === 'welcome') {
                wait = options.retry ?? 1000;
                welcome();
            } else if (message.type === 'reveal' && typeof message.uri === 'string' && typeof message.start === 'number') {
                const end = typeof message.end === 'number' ? message.end : message.start;
                revealed = `${message.uri}#${message.start}`;
                Promise.resolve(options.editor.reveal(message.uri, message.start, end)).catch(error => options.log?.(`Appling Desktop: ${error}`));
            } else if (message.type === 'diff' && typeof message.path === 'string' && typeof message.before === 'string' && typeof message.rev === 'string') {
                const line = typeof message.line === 'number' ? message.line : undefined;
                Promise.resolve(options.editor.diff(message.path, message.before, message.rev, line)).catch(error => options.log?.(`Appling Desktop: ${error}`));
            }
        };
        ws.onclose = event => {
            if (socket !== ws || disposed) return;
            // 4003: Desktop does not know the token (the instance was replaced); retrying cannot help
            if (event.code === 4003) return options.log?.('Appling Desktop rejected the bridge token.');
            bridge.welcomed = new Promise(resolve => welcome = resolve);
            timer = setTimeout(open, wait);
            wait = Math.min(wait * 2, 30000);
        };
        ws.onerror = () => undefined;
    };
    open();
    return bridge;
}

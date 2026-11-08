import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

/**
 * The local end of the agent's `ide` command: a process over the transport (ssh, docker exec, wsl.exe) whose stdio
 * carries the IDE server's IPC channel as JSON lines. It looks like a child process with an IPC channel to
 * `startIdeProcess` (`send`, `message`, `connected`, `disconnect`, `exit`), so a remote server talks to Desktop as a
 * local one does. `rewrite` changes each message from the server before it is emitted (the ready URL becomes the
 * local end of the forwarded port).
 */
export class RelayProcess extends EventEmitter {
    connected = true;
    readonly stderr: Readable;
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;

    constructor(private readonly child: ChildProcess, private readonly rewrite: (message: unknown) => unknown = m => m) {
        super();
        this.stderr = child.stderr!;
        child.stdin!.on('error', () => undefined);
        createInterface({ input: child.stdout! }).on('line', line => {
            if (!line.trim()) return;
            let message: unknown;
            try {
                message = JSON.parse(line);
            } catch {
                return;
            }
            this.emit('message', this.rewrite(message));
        });
        child.once('error', error => this.emit('error', error));
        child.once('exit', (code, signal) => {
            this.exitCode = code;
            this.signalCode = signal;
            this.disconnected();
            this.emit('exit', code, signal);
        });
    }

    get pid(): number | undefined {
        return this.child.pid;
    }

    send(message: unknown): boolean {
        if (!this.connected) return false;
        this.child.stdin!.write(`${JSON.stringify(message)}\n`);
        return true;
    }

    /** Ends the channel: the agent then ends the server, as a local server ends with its IPC channel. */
    disconnect(): void {
        if (!this.connected) return;
        this.child.stdin!.end();
        this.disconnected();
    }

    kill(signal?: NodeJS.Signals): boolean {
        return this.child.kill(signal);
    }

    private disconnected(): void {
        if (!this.connected) return;
        this.connected = false;
        this.emit('disconnect');
    }

    /** As the child process type `startIdeProcess` takes. */
    asChild(): ChildProcess {
        return this as unknown as ChildProcess;
    }
}

/** The port of a server's ready URL (`http://127.0.0.1:<port>`). */
export function readyPort(message: unknown): number | undefined {
    const { type, url } = (message ?? {}) as { type?: unknown, url?: unknown };
    if (type !== 'ready' || typeof url !== 'string') return undefined;
    const port = Number(/^http:\/\/(?:127\.0\.0\.1|localhost):(\d+)/.exec(url)?.[1]);
    return Number.isInteger(port) && port > 0 ? port : undefined;
}

import type { ChildProcess } from 'node:child_process';
import { connect, createServer, type Server, type Socket } from 'node:net';
import type { Readable, Writable } from 'node:stream';

/**
 * Reverse forwards: a port of this machine (the agent gateway, the code bridge) made reachable on the loopback of the
 * machine a remote repo lives on, so the programs there (an agent session, the Appling extension in Code OSS) can
 * call back into Desktop. Over ssh this is `ssh -O forward -R` on the control master (`SshTransport.reverse`); over
 * `docker exec` and `wsl.exe` the agent's `reverse` command listens there and carries every connection over its
 * stdio, multiplexed in frames (this module).
 */
export interface ReverseForward {
    /** The port on the other side's 127.0.0.1. */
    readonly port: number;
    /** Calls back once when the forward stops on its own (the process or connection carrying it ended). */
    onEnd(listener: () => void): void;
    close(): Promise<void>;
}

/** Frame types: a connection opened there, bytes of a connection, a connection ended. */
const OPEN = 1;
const DATA = 2;
const END = 3;
const HEADER = 9;

/** One frame: type (1 byte), connection id (4 bytes), payload length (4 bytes), payload. */
export function encodeFrame(type: number, id: number, payload: Buffer = Buffer.alloc(0)): Buffer {
    const header = Buffer.alloc(HEADER);
    header.writeUInt8(type, 0);
    header.writeUInt32BE(id, 1);
    header.writeUInt32BE(payload.length, 5);
    return Buffer.concat([header, payload]);
}

/** Splits a byte stream into frames, across chunk borders. */
export class FrameReader {
    private buffer: Buffer = Buffer.alloc(0);

    push(chunk: Buffer): { type: number, id: number, payload: Buffer }[] {
        this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
        const frames: { type: number, id: number, payload: Buffer }[] = [];
        while (this.buffer.length >= HEADER) {
            const length = this.buffer.readUInt32BE(5);
            if (this.buffer.length < HEADER + length) break;
            frames.push({ type: this.buffer.readUInt8(0), id: this.buffer.readUInt32BE(1), payload: this.buffer.subarray(HEADER, HEADER + length) });
            this.buffer = this.buffer.subarray(HEADER + length);
        }
        return frames;
    }
}

/**
 * The TCP connections of one end, multiplexed over a byte stream to the other end. `open` makes the local socket for
 * a connection the other end announced (Desktop's side connects to the forwarded port); the other end announces its
 * own with `add`.
 */
export class Mux {
    private readonly sockets = new Map<number, Socket>();
    private readonly reader = new FrameReader();

    constructor(private readonly out: Writable, private readonly open?: (id: number) => Socket) {}

    /** Bytes from the other end. */
    feed(chunk: Buffer): void {
        for (const { type, id, payload } of this.reader.push(chunk)) {
            if (type === OPEN && this.open && !this.sockets.has(id)) this.add(id, this.open(id), false);
            else if (type === DATA) this.sockets.get(id)?.write(payload);
            else if (type === END) {
                const socket = this.sockets.get(id);
                this.sockets.delete(id);
                socket?.end();
            }
        }
    }

    /** Carries a socket of this end as connection `id`; `announce` tells the other end to open its side. */
    add(id: number, socket: Socket, announce = true): void {
        this.sockets.set(id, socket);
        if (announce) this.send(encodeFrame(OPEN, id));
        socket.on('data', (chunk: Buffer) => {
            if (!this.send(encodeFrame(DATA, id, chunk))) {
                socket.pause();
                this.out.once('drain', () => socket.resume());
            }
        });
        let ended = false;
        const end = () => {
            if (ended) return;
            ended = true;
            if (this.sockets.get(id) === socket) {
                this.sockets.delete(id);
                this.send(encodeFrame(END, id));
            }
        };
        socket.once('end', end);
        socket.once('close', end);
        socket.on('error', () => socket.destroy());
    }

    get size(): number {
        return this.sockets.size;
    }

    closeAll(): void {
        for (const socket of this.sockets.values()) socket.destroy();
        this.sockets.clear();
    }

    private send(frame: Buffer): boolean {
        return this.out.writable ? this.out.write(frame) : true;
    }
}

/**
 * The remote end, the agent's `reverse [port]` command: listens on 127.0.0.1 (on `preferred` when it is free, so
 * agents started earlier keep their URL), prints `{"port":N}` and a newline, then carries every connection to it
 * over stdio until stdin ends.
 */
export async function serveReverse(preferred: number, input: Readable, output: Writable): Promise<Server> {
    const mux = new Mux(output);
    let next = 1;
    const server = createServer(socket => mux.add(next++, socket));
    const port = await new Promise<number>((resolve, reject) => {
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
    output.write(`${JSON.stringify({ port })}\n`);
    input.on('data', (chunk: Buffer) => mux.feed(chunk));
    input.once('end', () => {
        mux.closeAll();
        server.close();
    });
    return server;
}

/**
 * Desktop's end of the agent's `reverse` command running over a transport: reads the port there, then connects every
 * connection made there to `localPort` here.
 */
export function stdioReverse(child: ChildProcess, localPort: number, timeout = 30000): Promise<ReverseForward> {
    return new Promise((resolve, reject) => {
        const mux = new Mux(child.stdin!, () => connect({ host: '127.0.0.1', port: localPort }));
        child.stdin!.on('error', () => undefined);
        let head: Buffer = Buffer.alloc(0);
        let port: number | undefined;
        let stderr = '';
        child.stderr?.on('data', chunk => stderr = (stderr + chunk).slice(-4000));
        const ends = new Set<() => void>();
        let ended = false;
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`The reverse forward did not start within ${timeout / 1000} s.`));
        }, timeout);
        child.stdout!.on('data', (chunk: Buffer) => {
            if (port !== undefined) return mux.feed(chunk);
            head = Buffer.concat([head, chunk]);
            const newline = head.indexOf(10);
            if (newline < 0) return;
            clearTimeout(timer);
            try {
                port = Number((JSON.parse(head.subarray(0, newline).toString('utf8')) as { port: number }).port);
            } catch {
                child.kill();
                return reject(new Error(`The reverse forward said: ${head.toString('utf8').trim()}`));
            }
            const rest = head.subarray(newline + 1);
            if (rest.length) mux.feed(rest);
            resolve({
                port,
                onEnd: listener => ended ? listener() : ends.add(listener),
                close: async () => {
                    ends.clear();
                    mux.closeAll();
                    child.stdin!.end();
                    child.kill();
                }
            });
        });
        child.once('error', error => {
            clearTimeout(timer);
            reject(error);
        });
        child.once('exit', code => {
            clearTimeout(timer);
            mux.closeAll();
            ended = true;
            if (port === undefined) reject(new Error(`The reverse forward ended with code ${code}.${stderr ? `\n${stderr.trim()}` : ''}`));
            for (const listener of [...ends]) listener();
            ends.clear();
        });
    });
}

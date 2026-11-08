import { rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';

/** Opens the stream on the other side for one local connection. */
export type Opener = () => Duplex;

/**
 * A local port (or Unix socket, or Windows pipe) whose connections each open a stream on the other side. The local end
 * stays while the other side comes and goes: `retarget` points it at a new remote port after a reconnect, so the
 * repo's view keeps its URL. Connections that arrive while there is no target wait for one.
 */
export class Forward {
    private open?: Opener;
    private readonly sockets = new Set<Socket>();
    private readonly waiting = new Set<() => void>();
    private constructor(private readonly server: Server, readonly port: number | undefined, readonly path: string | undefined, private readonly wait: number) {
        server.on('connection', socket => this.connection(socket));
    }

    /** Listens on 127.0.0.1 (a free port by default) or on a socket path. `wait` is how long a connection may wait for a target, 30 s by default. */
    static async listen(at: { port?: number } | { path: string } = {}, open?: Opener, wait = 30000): Promise<Forward> {
        const server = createServer();
        if ('path' in at && process.platform !== 'win32') rmSync(at.path, { force: true });
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            if ('path' in at) server.listen(at.path, resolve);
            else server.listen(at.port ?? 0, '127.0.0.1', resolve);
        });
        const address = server.address();
        const forward = new Forward(server, typeof address === 'object' && address ? address.port : undefined, 'path' in at ? at.path : undefined, wait);
        forward.retarget(open);
        return forward;
    }

    /** The local URL of a forwarded HTTP port. */
    get url(): string {
        return `http://127.0.0.1:${this.port}`;
    }

    /** Points new connections at another stream opener; `undefined` makes them wait. With `drop`, open connections end too. */
    retarget(open: Opener | undefined, drop = false): void {
        this.open = open;
        if (drop) this.drop();
        if (open) for (const resume of [...this.waiting]) resume();
    }

    /** Ends every open connection (their remote ends are gone after a reconnect). */
    drop(): void {
        for (const socket of this.sockets) socket.destroy();
    }

    get connections(): number {
        return this.sockets.size;
    }

    close(): Promise<void> {
        this.drop();
        for (const resume of [...this.waiting]) resume();
        return new Promise(resolve => this.server.close(() => resolve()));
    }

    private connection(socket: Socket): void {
        this.sockets.add(socket);
        socket.once('close', () => this.sockets.delete(socket));
        socket.on('error', () => socket.destroy());
        if (this.open) return this.pipe(socket, this.open);
        socket.pause();
        const resume = () => {
            clearTimeout(timer);
            this.waiting.delete(resume);
            if (this.open && !socket.destroyed && this.server.listening) this.pipe(socket, this.open);
            else socket.destroy();
        };
        const timer = setTimeout(resume, this.wait);
        this.waiting.add(resume);
    }

    private pipe(socket: Socket, open: Opener): void {
        let remote: Duplex;
        try {
            remote = open();
        } catch {
            socket.destroy();
            return;
        }
        remote.on('error', () => socket.destroy());
        remote.once('close', () => socket.destroy());
        socket.once('close', () => remote.destroy());
        socket.pipe(remote);
        remote.pipe(socket);
        socket.resume();
    }
}

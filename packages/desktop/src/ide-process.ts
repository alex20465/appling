import { spawn, type ChildProcess } from 'node:child_process';
import { ipcChannel, serveAppHost, servePlaybookStore, serveSessionStore, type AppHost, type PlaybookStore, type SessionStore } from '@appling/ai';
import { programPath } from './resources.js';

export interface IdeProcess {
    url: string;
    /** The repo's MCP server for agent sessions (bearer token of a session of the shared store). */
    mcp: string;
    child: ChildProcess;
    close(): void;
}

export interface IdeProcessOptions {
    /** The Node binary; inside Electron its own executable with `ELECTRON_RUN_AS_NODE`. */
    node?: string;
    env?: NodeJS.ProcessEnv;
    /** The server's entry, `ideMain()` by default. */
    main?: string;
    /** How long to wait for the server to report its URL. */
    timeout?: number;
    /** Called when the server ends on its own, such as after a crash. */
    onExit?(code: number | null, stderr: string): void;
    /** Called with what the server reports for the rail: the errors at start and after every model change, the unsaved files after each change. */
    onStatus?(status: IdeStatus): void;
    /** The agent sessions shared by every repo server, served to this one over its IPC channel. */
    sessions?: SessionStore;
    /** The workspace playbooks (#19), shared like the sessions; give them together with `sessions`. */
    playbooks?: PlaybookStore;
    /** What the app adds to a session's IDE context and does with its actions. */
    host?: AppHost;
    /**
     * Starts the server with these arguments (after its entry) somewhere else, such as on a remote machine through
     * the agent's relay (`remote/relay.ts`); by default `node <main> ...args` with an IPC channel here.
     */
    launch?(args: string[]): ChildProcess;
}

/** What a repo's server reports for the rail; each report carries one of the two. */
export interface IdeStatus {
    /** Validation errors in the repo's model. */
    errors?: number;
    /** Repo relative paths of the files with unsaved edits in the repo's view. */
    unsaved?: string[];
    /** Unseen model changes: files changed since the user last accepted them in the repo's view. */
    changes?: number;
}

/** The IDE server's entry, `appling-ide`: bundled in the packaged app, else the workspace package's. */
export function ideMain(): string {
    return programPath('ide');
}

/**
 * Starts the IDE server of one repo in its own process on a free port, so a failing repo cannot take the app down.
 * The server reports its URL over the IPC channel and ends when that channel closes, also when the app is killed.
 */
export function startIdeProcess(root: string, options: IdeProcessOptions = {}): Promise<IdeProcess> {
    const args = [root, '--port', '0', ...(options.sessions ? ['--shared-sessions'] : [])];
    const child = options.launch ? options.launch(args) : spawn(options.node ?? process.execPath, [options.main ?? ideMain(), ...args], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: options.env ?? process.env
    });
    const stops = [
        options.sessions && serveSessionStore(options.sessions, ipcChannel(child)),
        options.host && serveAppHost(options.host, ipcChannel(child)),
        options.playbooks && servePlaybookStore(options.playbooks, ipcChannel(child))
    ];
    child.once('exit', () => stops.forEach(stop => stop?.()));
    let stderr = '';
    child.stderr!.on('data', chunk => stderr = (stderr + chunk).slice(-4000));
    let ready = false;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => fail(new Error(`The IDE server for ${root} did not start within ${options.timeout ?? 30000}ms.`)), options.timeout ?? 30000);
        const fail = (error: Error) => {
            clearTimeout(timer);
            child.kill();
            reject(error);
        };
        child.once('error', fail);
        child.on('message', (message: { type?: string, url?: string, errors?: unknown, unsaved?: unknown, changes?: unknown }) => {
            if (message.type === 'status' && typeof message.changes === 'number') return options.onStatus?.({ changes: message.changes });
            if (message.type === 'status' && typeof message.errors === 'number') return options.onStatus?.({ errors: message.errors });
            if (message.type === 'status' && Array.isArray(message.unsaved)) return options.onStatus?.({ unsaved: message.unsaved.filter(f => typeof f === 'string') });
            if (message.type !== 'ready' || !message.url || ready) return;
            ready = true;
            clearTimeout(timer);
            resolve({ url: message.url, mcp: `${message.url}/mcp`, child, close: () => child.connected ? child.disconnect() : child.kill() });
        });
        child.once('exit', code => {
            if (!ready) return fail(new Error(`The IDE server for ${root} ended with code ${code}.${stderr ? `\n${stderr.trim()}` : ''}`));
            options.onExit?.(code, stderr);
        });
    });
}

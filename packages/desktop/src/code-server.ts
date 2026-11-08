import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The folders every instance shares: user data (settings on the server side, logs), extensions and server data. */
export interface CodeDirs {
    userDataDir: string;
    extensionsDir: string;
    serverDataDir: string;
}

/** The folders under the app's data folder. */
export function codeDirs(root: string): CodeDirs {
    return { userDataDir: join(root, 'user-data'), extensionsDir: join(root, 'extensions'), serverDataDir: join(root, 'server-data') };
}

/** A repo's stable key: its proxy path and token file name, the same on every start so its origin path stays. */
export function repoKey(repo: string): string {
    return createHash('sha256').update(repo).digest('hex').slice(0, 16);
}

export interface CodeServerOptions extends CodeDirs {
    /** The `openvscode-server` launcher. */
    binary: string;
    /** The repo's key, for its base path `/r/<key>` and its token file. */
    key: string;
    /** The connection token; random by default. */
    token?: string;
    env?: NodeJS.ProcessEnv;
    /** How long to wait for the server to listen. */
    timeout?: number;
    /** Called when the server ends on its own. */
    onExit?(code: number | null, output: string): void;
}

export interface CodeServer {
    port: number;
    token: string;
    child: ChildProcess;
    close(): Promise<void>;
}

/** The command line of one instance: local only, a free port, the token from a file, the shared folders. */
export function codeServerArgs(options: CodeServerOptions, tokenFile: string): string[] {
    return [
        '--host', '127.0.0.1', '--port', '0',
        '--connection-token-file', tokenFile,
        '--server-base-path', `/r/${options.key}`,
        '--user-data-dir', options.userDataDir,
        '--extensions-dir', options.extensionsDir,
        '--server-data-dir', options.serverDataDir,
        '--accept-server-license-terms',
        '--telemetry-level', 'off'
    ];
}

/** The port in the server's log line `Server bound to 127.0.0.1:<port> (IPv4)`. */
export function boundPort(output: string): number | undefined {
    const match = /Server bound to [^\s]*?:(\d+)/.exec(output);
    return match ? Number(match[1]) : undefined;
}

/**
 * Starts one openvscode-server for a repo. The connection token goes through a file only the user can read, so it is
 * not on the command line; the server picks a free port and the proxy routes the repo's base path to it.
 */
export function startCodeServer(options: CodeServerOptions): Promise<CodeServer> {
    const token = options.token ?? randomBytes(24).toString('base64url');
    const tokens = join(options.serverDataDir, 'tokens');
    mkdirSync(tokens, { recursive: true, mode: 0o700 });
    const tokenFile = join(tokens, options.key);
    writeFileSync(tokenFile, token, { mode: 0o600 });
    for (const dir of [options.userDataDir, options.extensionsDir]) mkdirSync(dir, { recursive: true });
    const child = spawn(options.binary, codeServerArgs(options, tokenFile), { stdio: ['ignore', 'pipe', 'pipe'], env: options.env ?? process.env });
    let output = '';
    let port: number | undefined;
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    return new Promise((resolve, reject) => {
        const timeout = options.timeout ?? 60000;
        const timer = setTimeout(() => fail(new Error(`The code view did not start within ${timeout}ms.\n${output.trim()}`)), timeout);
        const fail = (error: Error) => {
            clearTimeout(timer);
            child.kill();
            reject(error);
        };
        const read = (chunk: Buffer) => {
            output = (output + chunk).slice(-8000);
            if (port !== undefined) return;
            port = boundPort(output);
            if (port === undefined) return;
            clearTimeout(timer);
            resolve({
                port, token, child,
                close: async () => {
                    if (child.exitCode === null && child.signalCode === null) {
                        child.kill();
                        const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
                        await exited;
                        clearTimeout(kill);
                    }
                    rmSync(tokenFile, { force: true });
                }
            });
        };
        child.stdout!.on('data', read);
        child.stderr!.on('data', read);
        child.once('error', fail);
        child.once('exit', code => {
            if (port === undefined) return fail(new Error(`The code view ended with code ${code}.\n${output.trim()}`));
            options.onExit?.(code, output);
        });
    });
}

/** Installs an extension (an id from Open VSX or a `.vsix` path) into the shared extensions folder. */
export function installExtension(binary: string, extension: string, dirs: CodeDirs, env: NodeJS.ProcessEnv = process.env): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(binary, [
            '--install-extension', extension, '--force',
            '--user-data-dir', dirs.userDataDir, '--extensions-dir', dirs.extensionsDir, '--server-data-dir', dirs.serverDataDir,
            '--accept-server-license-terms'
        ], { stdio: ['ignore', 'pipe', 'pipe'], env });
        let output = '';
        child.stdout.on('data', chunk => output += chunk);
        child.stderr.on('data', chunk => output += chunk);
        child.once('error', reject);
        child.once('exit', code => code === 0 && !/Failed Installing/i.test(output)
            ? resolve()
            : reject(new Error(`Installing ${extension} failed (code ${code}): ${output.trim()}`)));
    });
}

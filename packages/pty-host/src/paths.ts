import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';

const WINDOWS = process.platform === 'win32';

/**
 * The per user folder of the host: its token, socket and log. `APPLING_PTY_HOST_DIR` overrides it.
 * Linux uses `$XDG_RUNTIME_DIR` (private to the user, cleared at logout of the last session) or `<tmp>/appling-<uid>`,
 * macOS its per user temp folder, Windows `%LOCALAPPDATA%\appling`.
 */
export function defaultDir(env: NodeJS.ProcessEnv = process.env): string {
    if (env.APPLING_PTY_HOST_DIR) return resolve(env.APPLING_PTY_HOST_DIR);
    if (WINDOWS) return join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'appling', 'pty-host');
    if (env.XDG_RUNTIME_DIR) return join(env.XDG_RUNTIME_DIR, 'appling-pty-host');
    return join(tmpdir(), `appling-pty-host-${process.getuid!()}`);
}

/** A Unix socket in the folder, or on Windows a named pipe whose name derives from the user and the folder. */
export function socketPath(dir: string): string {
    if (!WINDOWS) return join(dir, 'pty-host.sock');
    const hash = createHash('sha256').update(`${userInfo().username}\0${resolve(dir)}`).digest('hex').slice(0, 16);
    return `\\\\.\\pipe\\appling-pty-host-${hash}`;
}

export const tokenPath = (dir: string) => join(dir, 'token');
export const logPath = (dir: string) => join(dir, 'pty-host.log');

/**
 * Creates the folder with mode 0700 and refuses one that another user owns or others may enter,
 * since whoever can reach the socket and read the token controls every terminal.
 */
export function ensureDir(dir: string): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (WINDOWS) return;
    const stat = lstatSync(dir);
    if (!stat.isDirectory()) throw new Error(`${dir} is not a folder.`);
    if (stat.uid !== process.getuid!()) throw new Error(`${dir} belongs to another user.`);
    if (stat.mode & 0o077) throw new Error(`${dir} is open to other users (mode ${(stat.mode & 0o777).toString(8)}); it must be 0700.`);
}

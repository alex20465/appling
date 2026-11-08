import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Notifier } from '@appling/pty-host';
import { readCodeWorkspace } from '../code-workspace.js';
import { readSession } from '../session.js';
import { isRemoteId, parseLocation, type RemoteLocation } from './location.js';
import { RemoteStatus } from './notify.js';
import { RemoteRepo, type RemoteRepoOptions } from './remote-repo.js';

/**
 * Remote sessions while the app is closed (#18). A remote repo's pty host runs on its machine with `--no-notify`, and
 * only the app followed it (`RemoteStatus`). The tray mode now does the same while the app is not running: it reads the
 * remote repos of the saved workspaces, connects to each over the same transport the app uses (ssh master, docker
 * exec, wsl), but only to its pty host (`RemoteRepo` with `ptyOnly`, no IDE server), and follows its terminals with a
 * `RemoteStatus`: a terminal that needs input while nobody is attached raises the notification here, a reply goes to
 * the remote pty, and the tray lists and stops the remote sessions next to the local ones. While the app runs, it
 * follows its remote repos itself, so the tray lets go of the connections (`appRunning`) and no wait is raised twice.
 */

/** The file the app keeps while it runs, with its process id, in its user data folder. */
export const APP_PRESENCE = 'running.json';

/** Marks the app as running (its pid); `clear` removes the mark when it quits. */
export function markRunning(userData: string, pid = process.pid): { clear(): void } {
    const file = join(userData, APP_PRESENCE);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ pid })}\n`);
    return {
        clear: () => {
            try {
                if ((JSON.parse(readFileSync(file, 'utf8')) as { pid?: number }).pid === pid) rmSync(file, { force: true });
            } catch {
                // already gone
            }
        }
    };
}

/** Whether the app runs now: its mark is there and its process is alive (a crashed app leaves a stale mark). */
export function appRunning(userData: string, alive: (pid: number) => boolean = processAlive): boolean {
    const file = join(userData, APP_PRESENCE);
    if (!existsSync(file)) return false;
    try {
        const { pid } = JSON.parse(readFileSync(file, 'utf8')) as { pid?: unknown };
        return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && alive(pid);
    } catch {
        return false;
    }
}

function processAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // EPERM: it runs under another user, which is still a running process
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

/** The remote repos of the workspaces the app last had open (its `session.json`), each once, in rail order. */
export function knownRemoteRepos(appUserData: string, readFolders: (file: string) => string[] = file => readCodeWorkspace(file).folders.map(f => f.path)): string[] {
    const session = readSession(join(appUserData, 'session.json'));
    const repos = new Set<string>();
    for (const file of session?.workspaces ?? []) {
        let folders: string[] = [];
        try {
            folders = readFolders(file);
        } catch {
            continue;
        }
        for (const folder of folders) if (isRemoteId(folder)) repos.add(folder);
    }
    return [...repos];
}

export interface TrayRemotesOptions {
    /** The tray's own user data folder: the forwarded pty host sockets go to `remote/pty/<key>` there. */
    userData: string;
    /** The server bundle, should the install there be missing or older (the app installed it before). */
    app(): string;
    notifier: Notifier;
    /** A click on a remote terminal's notification or its Open entry: open the app at the repo. */
    open(repo: string, terminal: string): void;
    onChange(): void;
    log?(message: string): void;
    /** More options for every connection (tests pass the transport options and a Node binary). */
    repo?: Partial<Omit<RemoteRepoOptions, 'location' | 'ptyDir' | 'ptyOnly' | 'onConnected'>>;
}

/** The tray's connections to the pty hosts of remote repos, and the sessions there. */
export class TrayRemotes {
    readonly status: RemoteStatus;
    private readonly links = new Map<string, RemoteRepo>();

    constructor(private readonly options: TrayRemotesOptions) {
        this.status = new RemoteStatus({ notifier: options.notifier, open: options.open, log: options.log, onChange: options.onChange });
    }

    /** The local folder through which the tray reaches a repo's remote pty host. */
    ptyDir(repo: string): string {
        return join(this.options.userData, 'remote', 'pty', createHash('sha256').update(repo).digest('hex').slice(0, 12));
    }

    /** Follows exactly these remote repos: connects to the new ones, lets go of the others. */
    follow(repos: readonly string[]): void {
        for (const repo of [...this.links.keys()]) if (!repos.includes(repo)) void this.drop(repo);
        for (const repo of repos) if (!this.links.has(repo)) this.connect(repo);
    }

    /** Tries again the repos whose connection gave up (the host was off, the network away); the tray calls it now and then. */
    retry(): void {
        for (const [repo, link] of this.links) {
            if (link.connection.state === 'failed') link.retry().catch(error => this.options.log?.(`${repo} did not connect: ${(error as Error).message}`));
        }
    }

    /** The repos followed now (connected or still trying). */
    followed(): string[] {
        return [...this.links.keys()];
    }

    /** The sessions there, per connected repo. */
    terminals(): ReturnType<RemoteStatus['terminals']> {
        return this.status.terminals();
    }

    kill(repo: string, terminal: string): Promise<void> {
        return this.status.kill(repo, terminal);
    }

    /** Stops every running session of every followed repo there. */
    async stopAll(): Promise<void> {
        await Promise.all(this.terminals().flatMap(({ repo, terminals }) => terminals.filter(t => t.status.state !== 'exited').map(t => this.kill(repo, t.id).catch(() => undefined))));
    }

    async close(): Promise<void> {
        await Promise.all([...this.links.keys()].map(repo => this.drop(repo)));
    }

    private connect(repo: string): void {
        let location: RemoteLocation;
        try {
            location = parseLocation(repo) as RemoteLocation;
        } catch (error) {
            this.options.log?.(`${repo} is no remote repo: ${(error as Error).message}`);
            return;
        }
        const dir = this.ptyDir(repo);
        const link: RemoteRepo = new RemoteRepo({
            install: { app: this.options.app(), cache: join(this.options.userData, 'remote', 'cache') },
            ...this.options.repo,
            location,
            ptyDir: dir,
            ptyOnly: true,
            // after every (re)connect: the pty host there may be another one, follow it again
            onConnected: () => {
                if (this.links.get(repo) !== link) return;
                this.status.watch(repo, dir).catch(error => this.options.log?.(`The sessions of ${repo} are not followed: ${(error as Error).message}`));
            }
        });
        this.links.set(repo, link);
        link.start().catch(error => this.options.log?.(`${repo} did not connect: ${(error as Error).message}`));
    }

    private async drop(repo: string): Promise<void> {
        const link = this.links.get(repo);
        this.links.delete(repo);
        this.status.unwatch(repo);
        await link?.close().catch(() => undefined);
    }
}

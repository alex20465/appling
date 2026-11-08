import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parseGitStatus, type GitState } from '../git.js';
import type { IdeProcess, IdeProcessOptions } from '../ide-process.js';
import type { RailSource } from '../rail-status.js';
import type { ConnectionState } from './connection.js';
import { describeLocation, parseLocation, type RemoteLocation } from './location.js';
import { connectionContribution } from './rail.js';
import { RemoteRepo, type RemoteRepoOptions } from './remote-repo.js';
import { shellQuote } from './transport.js';

export interface RemoteReposOptions {
    /** The app's user data folder: downloads go to `remote/cache`, the forwarded pty host sockets to `remote/pty/<key>`. */
    userData: string;
    /** The folder with the server bundle (`serverBundle()`); asked for on the first remote repo. */
    app(): string;
    /** The rail's `connection` and `git` sources. */
    rail: { connection: RailSource, git: RailSource };
    /** More options for every repo (tests pass transports and a Node binary). */
    repo?: Partial<Omit<RemoteRepoOptions, 'location' | 'ide' | 'onState' | 'onConnected' | 'onProgress'>>;
    /** How often the remote git state is read; 10 s by default, 0 never. */
    gitInterval?: number;
}

export interface RemoteLaunch {
    /** The IDE server options of a local repo: the shared sessions, the app host, the rail status. */
    ide: Omit<IdeProcessOptions, 'launch' | 'onExit' | 'node' | 'main' | 'env'>;
    /** After every (re)connect with the IDE server's stable local URL; `again` after a reconnect (the view reloads). */
    onConnected(url: string, ide: IdeProcess, again: boolean): void;
    /** The first connect failed, or reconnecting gave up. */
    onFailed(error: string): void;
}

/**
 * The remote repos of the app, one `RemoteRepo` each, keyed by repo id. Reports each one's connection to the rail's
 * `connection` source and polls its git state (`git status` over the transport) into the `git` source.
 */
export class RemoteRepos {
    private readonly repos = new Map<string, RemoteRepo>();
    private readonly polls = new Map<string, NodeJS.Timeout>();

    constructor(private readonly options: RemoteReposOptions) {}

    get(id: string): RemoteRepo | undefined {
        return this.repos.get(id);
    }

    /** The local folder through which the repo's remote pty host is reached (`connectPtyHost({ dir, start: false })`). */
    ptyDir(id: string): string {
        return join(this.options.userData, 'remote', 'pty', createHash('sha256').update(id).digest('hex').slice(0, 12));
    }

    /** Connects a remote repo (or retries a failed one): installs the server there, starts it and forwards it. */
    async launch(id: string, launch: RemoteLaunch): Promise<void> {
        const existing = this.repos.get(id);
        if (existing) return existing.retry();
        const location = parseLocation(id) as RemoteLocation;
        const label = describeLocation(location);
        let failedReported = false;
        let progress: string | undefined;
        const report = (state: ConnectionState, detail: { attempt: number, error?: string, retryIn?: number }) => {
            if (this.repos.get(id) !== repo) return;
            this.options.rail.connection.set(id, connectionContribution(state, { label, ...detail, progress }));
            if (state === 'failed' && !failedReported) {
                failedReported = true;
                launch.onFailed(detail.error ?? `Could not connect to ${label}.`);
            }
            if (state !== 'failed') failedReported = false;
            if (state === 'connected') this.poll(id);
            else this.stopPoll(id);
        };
        const repo: RemoteRepo = new RemoteRepo({
            install: { app: this.options.app(), cache: join(this.options.userData, 'remote', 'cache') },
            ptyDir: this.ptyDir(id),
            ...this.options.repo,
            location,
            ide: launch.ide,
            onState: report,
            onProgress: line => {
                progress = line.replace(/…$/, '');
                if (repo.connection.state === 'connecting') report('connecting', { attempt: 0 });
            },
            onConnected: (url, again) => launch.onConnected(url, repo.ide!, again)
        });
        this.repos.set(id, repo);
        await repo.start();
    }

    async retry(id: string): Promise<void> {
        await this.repos.get(id)?.retry();
    }

    /** Disconnects and forgets a repo; its pty host and terminals keep running there. */
    async stop(id: string): Promise<void> {
        const repo = this.repos.get(id);
        this.repos.delete(id);
        this.stopPoll(id);
        this.options.rail.connection.clear(id);
        await repo?.close();
    }

    /** While the app quits: ends every connection at once (ssh masters, container watchers); the remote pty hosts keep running. */
    killAll(): void {
        for (const repo of this.repos.values()) {
            repo.ide?.close();
            void repo.transport.close();
        }
    }

    async closeAll(): Promise<void> {
        await Promise.all([...this.repos.keys()].map(id => this.stop(id)));
    }

    /** Reads the git state there now, then every `gitInterval`. */
    private poll(id: string): void {
        this.stopPoll(id);
        const interval = this.options.gitInterval ?? 10000;
        const read = async () => {
            const state = await this.gitState(id).catch(() => undefined);
            if (state && this.repos.has(id)) this.options.rail.git.set(id, { branch: state.branch, git: { upstream: state.upstream, ahead: state.ahead, behind: state.behind, dirty: state.dirty } });
        };
        void read();
        if (interval > 0) this.polls.set(id, setInterval(read, interval));
    }

    private stopPoll(id: string): void {
        clearInterval(this.polls.get(id));
        this.polls.delete(id);
    }

    /** `git status --porcelain=v2 --branch` in the repo's folder there; undefined when it is no git repo. */
    async gitState(id: string): Promise<GitState | undefined> {
        const repo = this.repos.get(id);
        if (!repo?.root || repo.connection.state !== 'connected') return undefined;
        const result = await repo.transport.exec(`git -C ${shellQuote(repo.root)} status --porcelain=v2 --branch`, { timeout: 20000 });
        return result.code === 0 ? parseGitStatus(result.stdout) : undefined;
    }
}

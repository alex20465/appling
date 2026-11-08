import { notificationText, PtyHostClient, type Notifier, type TerminalInfo } from '@appling/pty-host';

export interface RemoteStatusOptions {
    /** Raises the notification here, on this machine (`systemNotifier()` in the app). */
    notifier: Notifier;
    /** A click on a remote terminal's notification: show its repo. */
    open(repo: string, terminal: string): void;
    log?(message: string): void;
    /** The terminals of a watched repo changed (the tray redraws its list). */
    onChange?(): void;
}

interface Watched {
    client: PtyHostClient;
    /** The host's terminals, kept up to date from its events. */
    terminals: Map<string, TerminalInfo>;
    /** The `since` of each terminal's needs input status already notified, so each wait is raised once. */
    notified: Map<string, number>;
}

/**
 * Notifications for the terminals of remote repos. A remote pty host runs with `--no-notify` (its machine is not the
 * one the user sits at); this watcher subscribes to it through the repo's forwarded folder and raises the notification
 * on this machine for a terminal that needs input while no view is attached to it, as the local host does for its
 * own. A reply goes to the remote pty.
 */
export class RemoteStatus {
    private readonly watched = new Map<string, Watched>();
    /** What was notified for a repo whose connection dropped, until it is watched again. */
    private readonly seen = new Map<string, Map<string, number>>();

    constructor(private readonly options: RemoteStatusOptions) {}

    /** Follows the remote repo's pty host through `dir` (`RemoteRepos.ptyDir`); again after every reconnect. */
    async watch(repo: string, dir: string): Promise<void> {
        // a wait notified before a reconnect is not raised again
        const notified = this.watched.get(repo)?.notified ?? this.seen.get(repo) ?? new Map<string, number>();
        this.unwatch(repo);
        const client = await PtyHostClient.connect(dir);
        const watched: Watched = { client, notified, terminals: new Map() };
        this.watched.set(repo, watched);
        const changed = () => this.watched.get(repo) === watched && this.options.onChange?.();
        client.on('terminal', info => {
            watched.terminals.set(info.id, info);
            changed();
        });
        client.on('status', (terminal, status) => {
            const info = watched.terminals.get(terminal);
            if (info) watched.terminals.set(terminal, { ...info, status });
            changed();
            if (status.state === 'needsInput') void this.needsInput(repo, watched, terminal, status.since);
        });
        client.on('removed', terminal => {
            watched.notified.delete(terminal);
            watched.terminals.delete(terminal);
            changed();
        });
        client.on('close', () => {
            if (this.watched.get(repo) !== watched) return;
            this.watched.delete(repo);
            // the connection dropped: the next `watch` after the reconnect keeps what was notified
            this.seen.set(repo, watched.notified);
            this.options.onChange?.();
        });
        // terminals that waited while the app was away
        const list = await client.subscribe();
        for (const info of list) watched.terminals.set(info.id, info);
        changed();
        for (const info of list) {
            if (info.status.state === 'needsInput') void this.needsInput(repo, watched, info.id, info.status.since, info);
        }
    }

    /** The repos followed now, each with its terminals there. */
    terminals(): { repo: string, terminals: TerminalInfo[] }[] {
        return [...this.watched].map(([repo, watched]) => ({ repo, terminals: [...watched.terminals.values()] }));
    }

    /** Stops (or removes, when it ended) a terminal of a followed repo there. */
    async kill(repo: string, terminal: string): Promise<void> {
        await this.watched.get(repo)?.client.kill(terminal);
    }

    unwatch(repo: string): void {
        const watched = this.watched.get(repo);
        this.watched.delete(repo);
        this.seen.delete(repo);
        watched?.client.close();
        if (watched) this.options.onChange?.();
    }

    close(): void {
        for (const repo of [...this.watched.keys()]) this.unwatch(repo);
        this.seen.clear();
    }

    private async needsInput(repo: string, watched: Watched, terminal: string, since: number, known?: TerminalInfo): Promise<void> {
        if (watched.notified.get(terminal) === since) return;
        // the attachments right now: a view that shows the terminal makes the notification needless
        const info = known ?? (await watched.client.list().catch(() => [])).find(t => t.id === terminal);
        if (!info || info.attached || info.status.state !== 'needsInput' || info.status.since !== since || info.meta?.notify === 'off') return;
        // another call for the same wait may have raised it while this one waited for the list
        if (watched.notified.get(terminal) === since) return;
        watched.notified.set(terminal, since);
        const { title, body } = notificationText(info.status.notification, info);
        try {
            const answer = await this.options.notifier.notify({ terminal, title, body, reply: true });
            if (answer?.action === 'reply') watched.client.write(terminal, `${answer.text}\r`);
            else if (answer?.action === 'open') this.options.open(repo, terminal);
        } catch (error) {
            this.options.log?.(`The notification of ${terminal} in ${repo} failed: ${(error as Error).message}`);
        }
    }
}

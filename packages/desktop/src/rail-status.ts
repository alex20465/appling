import { resolve } from 'node:path';

/**
 * What the rail counts per repo; a workspace shows the sum over its repos. New features add a key here and feed it
 * through `RailStatus.set` under their own source name.
 */
export interface RailCounts {
    /** Agent sessions that are working. */
    agentsWorking: number;
    /** Agent sessions that wait for the user: needing input or blocked. */
    agentsWaiting: number;
    /** Agent sessions that failed. */
    agentsFailed: number;
    tasksRunning: number;
    tasksFailed: number;
    /** Validation errors of the repo's model. */
    errors: number;
    /** Files with edits not yet saved in the repo's view. */
    unsaved: number;
    /** Unseen model changes: files changed since the user last accepted them in the repo's view (#11). */
    unseen: number;
}

export type RailCount = keyof RailCounts;

/** Every count, most urgent first: the badge shows the first one above zero. */
export const RAIL_COUNTS: readonly RailCount[] = ['agentsWaiting', 'agentsFailed', 'tasksFailed', 'errors', 'agentsWorking', 'tasksRunning', 'unsaved', 'unseen'];

/** The counts a badge can show; unseen changes get a dot of their own on a background repo instead. */
const BADGE_COUNTS = RAIL_COUNTS.filter(key => key !== 'unseen');

/** A repo's git state beyond the branch (see `watchGit`). */
export interface RailGit {
    /** The branch it tracks, such as `origin/main`. */
    upstream?: string;
    ahead: number;
    behind: number;
    /** Files with uncommitted changes. */
    dirty: number;
}

/** What one source reports for one repo. */
export interface RailContribution {
    counts?: Partial<RailCounts>;
    /** The checked out branch (from the git source). */
    branch?: string;
    git?: RailGit;
    /** More lines for the repo's tooltip, such as `2 ahead, 1 behind`. */
    notes?: string[];
}

/** A repo's status: the counts summed over every source, the branch and the notes of every source. */
export interface RepoRailStatus {
    counts: RailCounts;
    branch?: string;
    git?: RailGit;
    notes: string[];
}

export function emptyCounts(): RailCounts {
    return { agentsWorking: 0, agentsWaiting: 0, agentsFailed: 0, tasksRunning: 0, tasksFailed: 0, errors: 0, unsaved: 0, unseen: 0 };
}

/**
 * The rail's status model. Each feature registers as a source (`source(name)`) and reports per repo what it knows;
 * a source owns its own contributions, so features never overwrite each other. Repos are keyed by absolute path.
 */
export class RailStatus {
    /** source -> repo -> contribution */
    private readonly sources = new Map<string, Map<string, RailContribution>>();
    private readonly listeners = new Set<() => void>();

    /** A handle for one feature: `set` a repo's contribution, `replace` all of them at once, `clear` one or all. */
    source(name: string): RailSource {
        return {
            set: (repo, contribution) => this.set(name, repo, contribution),
            replace: all => this.replace(name, all),
            clear: repo => this.clear(name, repo)
        };
    }

    set(source: string, repo: string, contribution: RailContribution): void {
        let repos = this.sources.get(source);
        if (!repos) this.sources.set(source, repos = new Map());
        const id = resolve(repo);
        if (same(repos.get(id), contribution)) return;
        repos.set(id, contribution);
        this.emit();
    }

    /** Sets a source's contributions for every repo; repos it does not name lose theirs. */
    replace(source: string, all: Map<string, RailContribution> | Record<string, RailContribution>): void {
        const next = new Map([...(all instanceof Map ? all : Object.entries(all))].map(([repo, c]) => [resolve(repo), c] as const));
        const current = this.sources.get(source) ?? new Map<string, RailContribution>();
        const unchanged = current.size === next.size && [...next].every(([repo, c]) => same(current.get(repo), c));
        this.sources.set(source, next);
        if (!unchanged) this.emit();
    }

    /** Drops a source's contribution for one repo, or for every repo; with no source, everything known of the repo. */
    clear(source: string | undefined, repo?: string): void {
        const id = repo === undefined ? undefined : resolve(repo);
        let changed = false;
        for (const [name, repos] of this.sources) {
            if (source !== undefined && name !== source) continue;
            if (id === undefined) {
                changed ||= repos.size > 0;
                repos.clear();
            } else changed = repos.delete(id) || changed;
        }
        if (changed) this.emit();
    }

    repo(repo: string): RepoRailStatus {
        const id = resolve(repo);
        const status: RepoRailStatus = { counts: emptyCounts(), notes: [] };
        for (const repos of this.sources.values()) {
            const contribution = repos.get(id);
            if (!contribution) continue;
            for (const key of RAIL_COUNTS) status.counts[key] += contribution.counts?.[key] ?? 0;
            if (contribution.branch !== undefined) status.branch = contribution.branch;
            if (contribution.git) status.git = contribution.git;
            status.notes.push(...contribution.notes ?? []);
        }
        return status;
    }

    /** The counts summed over the given repos (a workspace's folders). */
    sum(repos: Iterable<string>): RailCounts {
        const total = emptyCounts();
        for (const repo of new Set([...repos].map(r => resolve(r)))) {
            const { counts } = this.repo(repo);
            for (const key of RAIL_COUNTS) total[key] += counts[key];
        }
        return total;
    }

    /** Calls back after every change; returns the unsubscribe function. */
    onChange(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private emit(): void {
        this.listeners.forEach(listener => listener());
    }
}

export interface RailSource {
    set(repo: string, contribution: RailContribution): void;
    replace(all: Map<string, RailContribution> | Record<string, RailContribution>): void;
    clear(repo?: string): void;
}

function same(a: RailContribution | undefined, b: RailContribution): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

/** The most urgent count above zero, for the badge; undefined when everything is quiet. */
export function railBadge(counts: RailCounts): { kind: RailCount, count: number } | undefined {
    const kind = BADGE_COUNTS.find(key => counts[key] > 0);
    return kind && { kind, count: counts[kind] };
}

const LABELS: Record<RailCount, [string, string]> = {
    agentsWaiting: ['agent needs input', 'agents need input'],
    agentsFailed: ['agent failed', 'agents failed'],
    tasksFailed: ['task failed', 'tasks failed'],
    errors: ['validation error', 'validation errors'],
    agentsWorking: ['agent working', 'agents working'],
    tasksRunning: ['task running', 'tasks running'],
    unsaved: ['unsaved file', 'unsaved files'],
    unseen: ['changed file not yet seen', 'changed files not yet seen']
};

/**
 * The tooltip lines of a status: the git line (`On main, 2 ahead and 1 behind origin/main, 3 changed files`), the
 * counts above zero, most urgent first, then the sources' notes.
 */
export function railLines(status: { counts: RailCounts, branch?: string, git?: RailGit, notes?: string[] }): string[] {
    return [
        ...status.branch ? [gitLine(status.branch, status.git)] : [],
        ...RAIL_COUNTS.filter(key => status.counts[key] > 0).map(key => `${status.counts[key]} ${LABELS[key][status.counts[key] > 1 ? 1 : 0]}`),
        ...status.notes ?? []
    ];
}

function gitLine(branch: string, git: RailGit | undefined): string {
    if (!git) return `On ${branch}`;
    const sync = git.ahead || git.behind
        ? `, ${[git.ahead && `${git.ahead} ahead`, git.behind && `${git.behind} behind`].filter(Boolean).join(' and ')} ${git.upstream ?? 'its upstream'}` : '';
    const dirty = git.dirty ? `, ${git.dirty} changed file${git.dirty > 1 ? 's' : ''}` : '';
    return `On ${branch}${sync}${dirty}`;
}

/** The agent sessions source: per repo, how many sessions are working, wait for the user or failed. */
export function agentContributions(sessions: readonly { repo: string, status: string }[]): Map<string, RailContribution> {
    const result = new Map<string, RailContribution>();
    for (const session of sessions) {
        const key = session.status === 'working' ? 'agentsWorking'
            : session.status === 'needs-input' || session.status === 'blocked' ? 'agentsWaiting'
            : session.status === 'failed' ? 'agentsFailed' : undefined;
        if (!key) continue;
        const id = resolve(session.repo);
        const counts = result.get(id)?.counts ?? {};
        counts[key] = (counts[key] ?? 0) + 1;
        result.set(id, { counts });
    }
    return result;
}

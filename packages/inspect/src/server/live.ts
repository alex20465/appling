import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { URI } from 'langium';
import { findApplingFiles } from '@appling/model';
import { diffGraphs, withRemoved } from '@appling/model/diff';
import { buildSnapshot } from '../shared/model.js';
import { commitOf, filesAt } from './git.js';
import type { LiveChanges, LiveFile } from '../shared/live.js';
import type { Snapshot } from '../shared/snapshot.js';

/**
 * Tracks every model change against a baseline: the model files at git `HEAD` (`followHead`), or outside git and
 * before the first commit the files on disk when the server started. It sees every write, through the MCP tools or by
 * any other process, since it compares the snapshots the file watcher builds. Files written by an agent session's
 * tool calls are attributed to it.
 */
export class LiveTracker {
    private baseline = new Map<string, string>();
    private head?: string;
    /** The snapshot of the baseline texts, built when first needed. */
    private base?: Promise<Snapshot>;
    private now?: Snapshot;
    private readonly sessions = new Map<string, Set<string>>();
    private readonly times = new Map<string, string>();
    private state: LiveChanges = { files: [], diff: { changes: [], added: [], changed: [], removed: [], renamed: {} }, ghosts: { nodes: [], edges: [] } };
    private queue: Promise<unknown> = Promise.resolve();

    constructor(private readonly root: string, private readonly emit: (live: LiveChanges) => void = () => undefined) {
        for (const file of findApplingFiles(root)) this.baseline.set(relative(root, file), readFileSync(file, 'utf8'));
    }

    /** The changes as last computed. */
    current(): LiveChanges {
        return this.state;
    }

    /** Takes the model files at `HEAD` as the baseline when `HEAD` moved, such as after a commit or a checkout. */
    async followHead(): Promise<LiveChanges> {
        const commit = await commitOf(this.root, 'HEAD').catch(() => undefined);
        if (!commit || commit === this.head) return this.state;
        const files = await filesAt(this.root, commit);
        this.head = commit;
        this.baseline = new Map(files.map(f => [f.path, f.text]));
        this.base = undefined;
        return this.recompute();
    }

    /** Compares a new snapshot of the files on disk with the baseline and emits the changes. */
    update(snapshot: Snapshot): Promise<LiveChanges> {
        this.now = snapshot;
        return this.recompute();
    }

    /** Attributes the files an agent session's tool call wrote, relative to the workspace folder or absolute. */
    attribute(session: string, files: string[]): Promise<LiveChanges> {
        for (const file of files) {
            const path = relative(this.root, resolve(this.root, file));
            if (!this.sessions.has(path)) this.sessions.set(path, new Set());
            this.sessions.get(path)!.add(session);
        }
        return this.recompute();
    }

    private disk(path: string): string | null {
        const file = resolve(this.root, path);
        return existsSync(file) ? readFileSync(file, 'utf8') : null;
    }

    private recompute(): Promise<LiveChanges> {
        const next = this.queue.then(() => this.compute()).then(state => {
            this.state = state;
            this.emit(state);
            return state;
        });
        this.queue = next.catch(error => console.error(error));
        return next;
    }

    private async compute(): Promise<LiveChanges> {
        const now = this.now;
        if (!now) return this.state;
        this.base ??= buildSnapshot(now.root, [...this.baseline].map(([path, text]) => ({ uri: URI.file(resolve(this.root, path)).toString(), path, text })));
        const base = await this.base;
        const texts = new Map(now.files.map(f => [f.path, f.text]));
        const previous = new Map(this.state.files.map(f => [f.path, f]));
        const at = new Date().toISOString();
        const files: LiveFile[] = [];
        for (const path of new Set([...this.baseline.keys(), ...texts.keys()])) {
            const [before, after] = [this.baseline.get(path) ?? null, texts.get(path) ?? null];
            if (before === after) {
                // An attribution may come before the watcher's snapshot of the write: keep it until the disk agrees.
                if (this.disk(path) === before) this.sessions.delete(path);
                this.times.delete(path);
                continue;
            }
            if (previous.get(path)?.after !== after || !this.times.has(path)) this.times.set(path, at);
            files.push({
                path, before, after, elements: [], at: this.times.get(path)!,
                status: before === null ? 'added' : after === null ? 'deleted' : 'modified',
                sessions: [...this.sessions.get(path) ?? []]
            });
        }
        const diff = diffGraphs(base.graph, now.graph);
        const byPath = new Map(files.map(f => [f.path, f]));
        const pathOf = (snapshot: Snapshot, qn: string) => {
            const uri = snapshot.locations[qn]?.uri;
            return uri && snapshot.files.find(f => f.uri === uri)?.path;
        };
        for (const change of diff.changes) {
            const path = change.status === 'removed' ? pathOf(base, change.qn) : pathOf(now, change.qn) ?? pathOf(base, change.was ?? change.qn);
            if (path) byPath.get(path)?.elements.push(change.qn);
        }
        const drawn = withRemoved(base.graph, now.graph, diff);
        const ghosts = { nodes: drawn.nodes.slice(now.graph.nodes.length), edges: drawn.edges.slice(now.graph.edges.length) };
        files.sort((a, b) => b.at.localeCompare(a.at) || a.path.localeCompare(b.path));
        return { files, diff, ghosts };
    }
}

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { URI } from 'langium';
import { findApplingFiles } from '@appling/model';
import { diffGraphs, withRemoved } from '@appling/model/diff';
import { buildSnapshot } from '../shared/model.js';
import type { LiveChanges, LiveFile } from '../shared/live.js';
import type { Snapshot } from '../shared/snapshot.js';

/**
 * Tracks every model change against a baseline: the text of each model file when the user last accepted it, starting
 * with the files on disk when the server started. It sees every write, through the MCP tools or by any other process,
 * since it compares the snapshots the file watcher builds. Accepting a file moves its baseline to its text now;
 * reverting it writes the baseline text back. Files written by an agent session's tool calls are attributed to it.
 */
export class LiveTracker {
    private readonly baseline = new Map<string, string>();
    /** The snapshot of the baseline texts, built when first needed and after every change of the baseline. */
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

    /** Accepts the changes of these files, or of every changed file: their baseline becomes their text now. */
    acknowledge(paths?: string[]): Promise<LiveChanges> {
        const accepted = paths ?? this.state.files.map(f => f.path);
        for (const path of accepted) {
            const text = this.textNow(path);
            if (text === null) this.baseline.delete(path);
            else this.baseline.set(path, text);
            this.sessions.delete(path);
        }
        this.base = undefined;
        return this.recompute();
    }

    /** Writes the baseline text of a changed file back, or deletes a file that did not exist then; the watcher follows. */
    revert(path: string): { ok: boolean, reason?: string } {
        const file = this.inside(path);
        if (!file) return { ok: false, reason: 'Only .appling files inside the workspace can be reverted.' };
        const before = this.baseline.get(path);
        if (before === undefined) {
            if (existsSync(file)) rmSync(file);
        } else {
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, before);
        }
        return { ok: true };
    }

    /**
     * A write the user makes in the IDE: when the file has no unseen change, its baseline follows the write, so the
     * user's own edits are not marked; on top of an unseen change it stays, so that change is not swallowed.
     */
    own(path: string, text: string): void {
        const file = this.inside(path);
        if (!file) return;
        if ((this.baseline.get(path) ?? null) !== this.disk(path)) return;
        this.baseline.set(path, text);
        this.base = undefined;
    }

    private inside(path: string): string | undefined {
        const file = resolve(this.root, path);
        return file.startsWith(resolve(this.root) + sep) && file.endsWith('.appling') ? file : undefined;
    }

    private textNow(path: string): string | null {
        return this.now ? this.now.files.find(f => f.path === path)?.text ?? null : this.disk(path);
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

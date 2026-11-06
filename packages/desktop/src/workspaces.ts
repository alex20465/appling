import { resolve } from 'node:path';
import { workspaceName, type WorkspaceFolder } from './code-workspace.js';

/** An open workspace; its id is the absolute path of its `.code-workspace` file. */
export interface Workspace {
    id: string;
    name: string;
    /** Its repos in rail order (the file's folder order). */
    folders: WorkspaceFolder[];
    /** The repo shown when the workspace is active. */
    active?: string;
    /** Repos pinned to the top of the rail, kept in folder order. */
    pinned: string[];
    /** Repos left out of the rail (and of Ctrl+1..9); they keep running and the switcher still finds them. */
    hidden: string[];
}

/** The pins and hidden repos of one workspace, as a session saves them. */
export interface RailLayout {
    pinned?: string[];
    hidden?: string[];
}

/** How long after a most recently used step the next one continues the same walk instead of starting over. */
export const WALK_MS = 1200;

/**
 * The open workspaces in rail order, the active one, and the repos in most recently used order.
 * Pure state: the main process starts one IDE server per repo in `live()` and shows the active repo's view.
 * A folder may sit in several workspaces; it is still one repo with one server and one view.
 */
export class Workspaces {
    private readonly list: Workspace[] = [];
    active?: string;
    /** Repo ids, the most recently shown first. */
    private recent: string[] = [];
    private walk?: { order: string[], at: number, until: number };
    /** Whether the rail is folded away, so the repo view takes the whole window. */
    collapsed = false;

    all(): readonly Workspace[] {
        return this.list;
    }

    get(id: string): Workspace | undefined {
        return this.list.find(w => w.id === resolve(id));
    }

    current(): Workspace | undefined {
        return this.active ? this.get(this.active) : undefined;
    }

    /** The repo whose view is shown. */
    activeRepo(): string | undefined {
        return this.current()?.active;
    }

    /** Every repo of an open workspace: the repos that need a server. */
    live(): Set<string> {
        return new Set(this.list.flatMap(w => w.folders.map(f => f.path)));
    }

    /** Opens a workspace with its folders and activates it; one open already is only activated. Returns it and whether it is new. */
    open(file: string, folders: WorkspaceFolder[]): { workspace: Workspace, added: boolean } {
        const id = resolve(file);
        const existing = this.get(id);
        this.active = id;
        if (existing) {
            this.touch(existing.active);
            return { workspace: existing, added: false };
        }
        const unique = dedupe(folders);
        const workspace: Workspace = { id, name: workspaceName(id), folders: unique, active: unique[0]?.path, pinned: [], hidden: [] };
        this.list.push(workspace);
        this.touch(workspace.active);
        return { workspace, added: true };
    }

    /** Closes a workspace; the active one passes to its right neighbour, or the left one at the end. */
    close(id: string): Workspace | undefined {
        const at = this.list.findIndex(w => w.id === resolve(id));
        if (at < 0) return undefined;
        const [workspace] = this.list.splice(at, 1);
        if (this.active === workspace.id) {
            this.active = (this.list[at] ?? this.list[at - 1])?.id;
            this.touch(this.activeRepo());
        }
        this.forget();
        return workspace;
    }

    /** Adds a folder to a workspace (at the end) and shows it; false when it is in there already (then it is only shown). */
    addRepo(workspaceId: string, folder: string): boolean {
        const workspace = this.get(workspaceId);
        if (!workspace) return false;
        const path = resolve(folder);
        const added = !workspace.folders.some(f => f.path === path);
        if (added) workspace.folders.push({ path });
        this.select(path, workspace.id);
        return added;
    }

    /** Removes a repo from a workspace; the workspace's active repo passes to the neighbour. */
    removeRepo(workspaceId: string, repo: string): boolean {
        const workspace = this.get(workspaceId);
        const path = resolve(repo);
        const at = workspace ? workspace.folders.findIndex(f => f.path === path) : -1;
        if (!workspace || at < 0) return false;
        workspace.folders.splice(at, 1);
        workspace.pinned = workspace.pinned.filter(r => r !== path);
        workspace.hidden = workspace.hidden.filter(r => r !== path);
        if (workspace.active === path) {
            workspace.active = (workspace.folders[at] ?? workspace.folders[at - 1])?.path;
            if (workspace.id === this.active) this.touch(workspace.active);
        }
        this.forget();
        return true;
    }

    /** Moves a repo to the end of another workspace, keeping its display name, and shows it there. */
    moveRepo(repo: string, from: string, to: string): boolean {
        const source = this.get(from);
        const target = this.get(to);
        const path = resolve(repo);
        const folder = source?.folders.find(f => f.path === path);
        if (!source || !target || !folder || source === target) return false;
        this.removeRepo(source.id, path);
        if (!target.folders.some(f => f.path === path)) target.folders.push(folder);
        this.select(path, target.id);
        return true;
    }

    /** Shows a repo: in the given workspace, else the active one when it holds the repo, else the first that does. */
    select(repo: string, workspaceId?: string): boolean {
        const path = resolve(repo);
        const holds = (w?: Workspace) => w?.folders.some(f => f.path === path) ? w : undefined;
        const workspace = holds(workspaceId ? this.get(workspaceId) : undefined) ?? holds(this.current()) ?? this.list.find(w => holds(w));
        if (!workspace) return false;
        workspace.active = path;
        this.active = workspace.id;
        this.touch(path);
        return true;
    }

    selectWorkspace(id: string): boolean {
        const workspace = this.get(id);
        if (!workspace) return false;
        this.active = workspace.id;
        this.touch(workspace.active);
        return true;
    }

    /** The repos the rail shows for a workspace, in its order: pinned ones first, hidden ones left out. */
    rail(workspaceId: string): WorkspaceFolder[] {
        const workspace = this.get(workspaceId);
        if (!workspace) return [];
        const shown = workspace.folders.filter(f => !workspace.hidden.includes(f.path));
        return [...shown.filter(f => workspace.pinned.includes(f.path)), ...shown.filter(f => !workspace.pinned.includes(f.path))];
    }

    /** Pins a repo to the top of its workspace's rail, or unpins it (false). Pinning shows a hidden repo again. */
    pin(workspaceId: string, repo: string, pinned: boolean): boolean {
        const workspace = this.get(workspaceId);
        const path = resolve(repo);
        if (!workspace?.folders.some(f => f.path === path) || workspace.pinned.includes(path) === pinned) return false;
        workspace.pinned = pinned ? [...workspace.pinned, path] : workspace.pinned.filter(r => r !== path);
        if (pinned) workspace.hidden = workspace.hidden.filter(r => r !== path);
        return true;
    }

    /**
     * Hides a repo from its workspace's rail, or shows it again (false). Hiding the shown repo shows the next one in
     * the rail; a hidden repo keeps its server and view, and selecting it (through the switcher) works as before.
     */
    hide(workspaceId: string, repo: string, hidden: boolean): boolean {
        const workspace = this.get(workspaceId);
        const path = resolve(repo);
        if (!workspace?.folders.some(f => f.path === path) || workspace.hidden.includes(path) === hidden) return false;
        if (!hidden) {
            workspace.hidden = workspace.hidden.filter(r => r !== path);
            return true;
        }
        const rail = this.rail(workspace.id).map(f => f.path);
        const at = rail.indexOf(path);
        workspace.hidden = [...workspace.hidden, path];
        workspace.pinned = workspace.pinned.filter(r => r !== path);
        if (workspace.active === path) {
            const next = rail[at + 1] ?? rail[at - 1];
            if (next) {
                workspace.active = next;
                if (workspace.id === this.active) this.touch(next);
            }
        }
        return true;
    }

    /**
     * Moves a repo in its workspace's folder order to just before `before` (to the end without it), as a drop in the
     * rail does. It joins the group of the repo it lands next to: dropped on a pinned repo it is pinned, else unpinned.
     */
    reorder(workspaceId: string, repo: string, before?: string): boolean {
        const workspace = this.get(workspaceId);
        const path = resolve(repo);
        const target = before === undefined ? undefined : resolve(before);
        const from = workspace ? workspace.folders.findIndex(f => f.path === path) : -1;
        if (!workspace || from < 0 || target === path) return false;
        if (target !== undefined && !workspace.folders.some(f => f.path === target)) return false;
        const [folder] = workspace.folders.splice(from, 1);
        const to = target === undefined ? workspace.folders.length : workspace.folders.findIndex(f => f.path === target);
        workspace.folders.splice(to, 0, folder);
        const pinned = target !== undefined && workspace.pinned.includes(target);
        workspace.pinned = workspace.pinned.filter(r => r !== path);
        if (pinned) workspace.pinned.push(path);
        workspace.pinned.sort((a, b) => workspace.folders.findIndex(f => f.path === a) - workspace.folders.findIndex(f => f.path === b));
        return true;
    }

    /** Shows the n-th repo (0 based) of the active workspace's rail. */
    selectAt(index: number): boolean {
        const folder = this.active ? this.rail(this.active)[index] : undefined;
        return folder ? this.select(folder.path, this.active) : false;
    }

    /** Activates the n-th workspace (0 based). */
    selectWorkspaceAt(index: number): boolean {
        const workspace = this.list[index];
        return workspace ? this.selectWorkspace(workspace.id) : false;
    }

    /** Activates the next (+1) or previous (-1) workspace, wrapping around. */
    cycleWorkspace(step: 1 | -1): void {
        if (!this.list.length) return;
        const at = this.list.findIndex(w => w.id === this.active);
        this.selectWorkspace(this.list[(at + step + this.list.length) % this.list.length].id);
    }

    /** The repos of every open workspace, the most recently shown first. */
    mostRecent(): string[] {
        return [...this.recent];
    }

    /**
     * Steps through the repos of every workspace in most recently used order, as Ctrl+Tab does: a step within
     * `WALK_MS` of the last one goes one further along the same order, a later one starts over, so a single press
     * toggles between the last two repos.
     */
    stepRecent(step: 1 | -1, now: number): boolean {
        const walk = this.walk && now < this.walk.until ? this.walk : { order: this.mostRecent(), at: 0, until: 0 };
        if (walk.order.length < 2) return false;
        walk.at = (walk.at + step + walk.order.length) % walk.order.length;
        walk.until = now + WALK_MS;
        const target = walk.order[walk.at];
        this.select(target);
        this.walk = walk;
        return true;
    }

    /** Sets the shown repo per workspace, the active workspace and the most recently used order at once, as a restored session. Unknown ids are skipped. */
    arrange({ shown = {}, active, recent = [], rail = {}, collapsed }: {
        shown?: Record<string, string>, active?: string, recent?: string[], rail?: Record<string, RailLayout>, collapsed?: boolean
    }): void {
        for (const [id, repo] of Object.entries(shown)) {
            const workspace = this.get(id);
            if (workspace?.folders.some(f => f.path === resolve(repo))) workspace.active = resolve(repo);
        }
        for (const [id, layout] of Object.entries(rail)) {
            const workspace = this.get(id);
            if (!workspace) continue;
            const known = (repos: unknown) => Array.isArray(repos)
                ? [...new Set(repos.filter((r): r is string => typeof r === 'string').map(r => resolve(r)))].filter(r => workspace.folders.some(f => f.path === r))
                : [];
            workspace.hidden = known(layout.hidden);
            workspace.pinned = known(layout.pinned).filter(r => !workspace.hidden.includes(r))
                .sort((a, b) => workspace.folders.findIndex(f => f.path === a) - workspace.folders.findIndex(f => f.path === b));
        }
        if (collapsed !== undefined) this.collapsed = collapsed;
        if (active && this.get(active)) this.active = resolve(active);
        this.recent = recent.map(r => resolve(r));
        this.forget();
    }

    /** Moves a repo to the front of the most recently used order. */
    private touch(repo: string | undefined): void {
        if (!repo) return;
        this.recent = [repo, ...this.recent.filter(r => r !== repo)];
        this.forget();
    }

    /** Drops repos that left every workspace from the most recently used order and from a running walk. */
    private forget(): void {
        const live = this.live();
        this.recent = this.recent.filter(r => live.has(r));
        for (const path of live) if (!this.recent.includes(path)) this.recent.push(path);
        if (this.walk) this.walk.order = this.walk.order.filter(r => live.has(r));
    }
}

function dedupe(folders: WorkspaceFolder[]): WorkspaceFolder[] {
    const seen = new Set<string>();
    return folders.map(f => ({ ...f, path: resolve(f.path) })).filter(f => !seen.has(f.path) && seen.add(f.path));
}

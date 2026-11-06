import { basename, resolve } from 'node:path';

export type RepoStatus = 'starting' | 'ready' | 'failed';

/** A repo open in the app; its id is its absolute path. */
export interface Repo {
    id: string;
    name: string;
    status: RepoStatus;
    url?: string;
    error?: string;
}

/** The repos open in the app, in rail order, and the active one. Pure state: the main process maps it onto views. */
export class Repos {
    private readonly list: Repo[] = [];
    active?: string;

    all(): readonly Repo[] {
        return this.list;
    }

    get(id: string): Repo | undefined {
        return this.list.find(r => r.id === id);
    }

    /** Opens a folder and makes it active; a folder already open is only activated. Returns it and whether it is new. */
    add(folder: string): { repo: Repo, added: boolean } {
        const id = resolve(folder);
        const existing = this.get(id);
        this.active = id;
        if (existing) return { repo: existing, added: false };
        const repo: Repo = { id, name: basename(id) || id, status: 'starting' };
        this.list.push(repo);
        return { repo, added: true };
    }

    update(id: string, change: Partial<Omit<Repo, 'id' | 'name'>>): void {
        const repo = this.get(id);
        if (repo) Object.assign(repo, change);
    }

    /** Closes a repo; the active one passes to its right neighbour, or the left one at the end. */
    close(id: string): Repo | undefined {
        const at = this.list.findIndex(r => r.id === id);
        if (at < 0) return undefined;
        const [repo] = this.list.splice(at, 1);
        if (this.active === id) this.active = (this.list[at] ?? this.list[at - 1])?.id;
        return repo;
    }

    select(id: string): boolean {
        if (!this.get(id)) return false;
        this.active = id;
        return true;
    }

    /** Activates the n-th repo (0 based); false when there is none. */
    selectAt(index: number): boolean {
        const repo = this.list[index];
        return repo ? this.select(repo.id) : false;
    }

    /** Activates the next (+1) or previous (-1) repo, wrapping around. */
    cycle(step: 1 | -1): void {
        if (!this.list.length) return;
        const at = this.list.findIndex(r => r.id === this.active);
        this.active = this.list[(at + step + this.list.length) % this.list.length].id;
    }
}

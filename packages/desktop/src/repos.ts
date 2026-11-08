import { locationName, parseLocation, repoId } from './remote/location.js';

export type RepoStatus = 'starting' | 'ready' | 'failed';

/** A repo with a running (or failed) IDE server; its id is its absolute path, or its URI when remote (`remote/location.ts`). What the rail shows of it is in `RailStatus`. */
export interface Repo {
    id: string;
    name: string;
    status: RepoStatus;
    url?: string;
    error?: string;
}

/** The repos that have an IDE server, whichever workspaces they belong to (see `Workspaces`). */
export class Repos {
    private readonly map = new Map<string, Repo>();

    all(): Repo[] {
        return [...this.map.values()];
    }

    get(id: string): Repo | undefined {
        return this.map.get(repoId(id));
    }

    /** Registers a folder; one known already is returned as it is. Returns it and whether it is new. */
    add(folder: string): { repo: Repo, added: boolean } {
        const id = repoId(folder);
        const existing = this.map.get(id);
        if (existing) return { repo: existing, added: false };
        let name = id;
        try {
            name = locationName(parseLocation(id));
        } catch {
            // a malformed remote id keeps its text as its name
        }
        const repo: Repo = { id, name, status: 'starting' };
        this.map.set(id, repo);
        return { repo, added: true };
    }

    update(id: string, change: Partial<Omit<Repo, 'id' | 'name'>>): void {
        const repo = this.get(id);
        if (repo) Object.assign(repo, change);
    }

    close(id: string): Repo | undefined {
        const repo = this.get(id);
        if (repo) this.map.delete(repo.id);
        return repo;
    }
}

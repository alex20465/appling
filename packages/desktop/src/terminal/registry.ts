/**
 * Which terminals belong to which repo, and how they are arranged: per repo a row of tabs, each tab one or more
 * panes split side by side, plus whether the repo's terminal panel is open and how tall it is. Pure state; the
 * service persists it as `terminals.json` so tabs and splits come back after a restart.
 */

export interface TerminalTab {
    /** The id of the tab's first terminal, kept when that one closes. */
    id: string;
    /** Terminal ids, left to right. */
    panes: string[];
    /** The pane with the focus. */
    active: string;
}

export interface RepoTerminals {
    tabs: TerminalTab[];
    /** The shown tab's id. */
    active?: string;
    /** Whether the panel below the repo's view is open. */
    open: boolean;
    /** The panel's share of the repo area's height, from `MIN_HEIGHT` to `MAX_HEIGHT`. */
    height: number;
    /** Names given to terminals, by id. */
    names: Record<string, string>;
}

export const DEFAULT_HEIGHT = 0.35;
export const MIN_HEIGHT = 0.1;
export const MAX_HEIGHT = 0.9;

/** What `terminals.json` holds. */
export interface RegistryData {
    repos: Record<string, RepoTerminals>;
}

const empty = (): RepoTerminals => ({ tabs: [], open: false, height: DEFAULT_HEIGHT, names: {} });

export class TerminalRegistry {
    private readonly repos = new Map<string, RepoTerminals>();

    static from(data: unknown): TerminalRegistry {
        const registry = new TerminalRegistry();
        const repos = (data as RegistryData | undefined)?.repos;
        if (!repos || typeof repos !== 'object') return registry;
        for (const [repo, value] of Object.entries(repos)) {
            if (!value || !Array.isArray(value.tabs)) continue;
            const tabs = value.tabs
                .filter(tab => tab && typeof tab.id === 'string' && Array.isArray(tab.panes))
                .map(tab => {
                    const panes = tab.panes.filter((pane: unknown) => typeof pane === 'string');
                    return { id: tab.id, panes, active: panes.includes(tab.active) ? tab.active : panes[0] };
                })
                .filter(tab => tab.panes.length);
            const names = value.names && typeof value.names === 'object' ? Object.fromEntries(Object.entries(value.names).filter(([, n]) => typeof n === 'string')) as Record<string, string> : {};
            registry.repos.set(repo, {
                tabs,
                active: tabs.some(t => t.id === value.active) ? value.active : tabs[0]?.id,
                open: value.open === true,
                height: clampHeight(typeof value.height === 'number' ? value.height : DEFAULT_HEIGHT),
                names
            });
        }
        return registry;
    }

    toJSON(): RegistryData {
        return { repos: Object.fromEntries([...this.repos].filter(([, r]) => r.tabs.length || r.open || r.height !== DEFAULT_HEIGHT)) };
    }

    /** The repo's terminals; an empty, closed panel for a repo without any. */
    get(repo: string): RepoTerminals {
        return this.repos.get(repo) ?? empty();
    }

    /** Every repo with an entry. */
    all(): string[] {
        return [...this.repos.keys()];
    }

    private ensure(repo: string): RepoTerminals {
        let entry = this.repos.get(repo);
        if (!entry) this.repos.set(repo, entry = empty());
        return entry;
    }

    /** Every terminal of the repo, tab by tab. */
    terminals(repo: string): string[] {
        return this.get(repo).tabs.flatMap(tab => tab.panes);
    }

    repoOf(terminal: string): string | undefined {
        for (const [repo, entry] of this.repos) if (entry.tabs.some(tab => tab.panes.includes(terminal))) return repo;
        return undefined;
    }

    /**
     * Adds a terminal to the repo, in a new tab after the shown one, or with `split` next to the focused pane of the
     * shown tab. It becomes the shown, focused terminal and the panel opens.
     */
    add(repo: string, terminal: string, options: { split?: boolean, name?: string } = {}): void {
        if (this.repoOf(terminal)) return;
        const entry = this.ensure(repo);
        const tab = entry.tabs.find(t => t.id === entry.active);
        if (options.split && tab) {
            tab.panes.splice(tab.panes.indexOf(tab.active) + 1, 0, terminal);
            tab.active = terminal;
        } else {
            const at = tab ? entry.tabs.indexOf(tab) + 1 : entry.tabs.length;
            entry.tabs.splice(at, 0, { id: terminal, panes: [terminal], active: terminal });
            entry.active = terminal;
        }
        if (options.name) entry.names[terminal] = options.name;
        entry.open = true;
    }

    /** Removes a terminal; an emptied tab goes and its neighbour is shown. Returns its repo. */
    remove(terminal: string): string | undefined {
        const repo = this.repoOf(terminal);
        if (!repo) return undefined;
        const entry = this.repos.get(repo)!;
        const index = entry.tabs.findIndex(t => t.panes.includes(terminal));
        const tab = entry.tabs[index];
        const pane = tab.panes.indexOf(terminal);
        tab.panes.splice(pane, 1);
        delete entry.names[terminal];
        if (tab.panes.length) {
            if (tab.active === terminal) tab.active = tab.panes[Math.min(pane, tab.panes.length - 1)];
        } else {
            entry.tabs.splice(index, 1);
            if (entry.active === tab.id) entry.active = entry.tabs[Math.min(index, entry.tabs.length - 1)]?.id;
            if (!entry.tabs.length) entry.open = false;
        }
        return repo;
    }

    /** Shows the terminal's tab and focuses the terminal. */
    focus(terminal: string): boolean {
        const repo = this.repoOf(terminal);
        if (!repo) return false;
        const entry = this.repos.get(repo)!;
        const tab = entry.tabs.find(t => t.panes.includes(terminal))!;
        if (entry.active === tab.id && tab.active === terminal) return false;
        entry.active = tab.id;
        tab.active = terminal;
        return true;
    }

    /** The shown tab's focused terminal. */
    focused(repo: string): string | undefined {
        const entry = this.get(repo);
        return entry.tabs.find(t => t.id === entry.active)?.active;
    }

    /** Moves the tab one step left (`-1`) or right (`1`), or to an index. */
    moveTab(repo: string, tab: string, to: number): boolean {
        const entry = this.repos.get(repo);
        const from = entry?.tabs.findIndex(t => t.id === tab) ?? -1;
        if (!entry || from < 0) return false;
        const target = Math.max(0, Math.min(entry.tabs.length - 1, to));
        if (target === from) return false;
        entry.tabs.splice(target, 0, ...entry.tabs.splice(from, 1));
        return true;
    }

    /** Shows the next (`1`) or previous (`-1`) tab, wrapping around. */
    cycleTab(repo: string, step: number): boolean {
        const entry = this.repos.get(repo);
        if (!entry || entry.tabs.length < 2) return false;
        const index = entry.tabs.findIndex(t => t.id === entry.active);
        entry.active = entry.tabs[(index + step + entry.tabs.length) % entry.tabs.length].id;
        return true;
    }

    rename(terminal: string, name: string | undefined): boolean {
        const repo = this.repoOf(terminal);
        if (!repo) return false;
        const names = this.repos.get(repo)!.names;
        if (name?.trim()) names[terminal] = name.trim();
        else delete names[terminal];
        return true;
    }

    setOpen(repo: string, open: boolean): boolean {
        const entry = this.ensure(repo);
        if (entry.open === open) return false;
        entry.open = open;
        return true;
    }

    setHeight(repo: string, height: number): boolean {
        const entry = this.ensure(repo);
        const value = clampHeight(height);
        if (entry.height === value) return false;
        entry.height = value;
        return true;
    }

    /** Forgets a repo and returns its terminals. */
    removeRepo(repo: string): string[] {
        const terminals = this.terminals(repo);
        this.repos.delete(repo);
        return terminals;
    }

    /**
     * Matches the saved arrangement to the terminals the pty host still has for the repo: ended or lost terminals
     * leave their tabs, terminals the host has but the registry does not (started by another app instance or before a
     * crash) get a tab each, in the host's order. Returns whether anything changed.
     */
    reconcile(repo: string, live: string[]): boolean {
        const alive = new Set(live);
        let changed = false;
        for (const terminal of this.terminals(repo)) {
            if (!alive.has(terminal)) {
                this.remove(terminal);
                changed = true;
            }
        }
        const known = new Set(this.terminals(repo));
        for (const terminal of live) {
            if (known.has(terminal) || this.repoOf(terminal)) continue;
            const entry = this.ensure(repo);
            entry.tabs.push({ id: terminal, panes: [terminal], active: terminal });
            entry.active ??= terminal;
            changed = true;
        }
        return changed;
    }
}

function clampHeight(height: number): number {
    return Number.isFinite(height) ? Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, height)) : DEFAULT_HEIGHT;
}

import { resolve } from 'node:path';
import { displayFingerprint, type DisplayInfo, type Rect } from './displays.js';
import { parsePane } from './panes.js';

/** The id of the main window: it holds every workspace no other window holds, and closing it quits the app. */
export const MAIN = 'main';

/** One window of the app: its rail, its switcher, the workspaces it holds and the panes moved into it. */
export interface AppWindow {
    id: string;
    /** The workspaces it holds, besides the main window, which holds every workspace no other window holds. */
    workspaces: string[];
    /** Panes moved into it from their repo's window, in column order; they stay shown whichever repo it shows. */
    panes: string[];
    /** The workspace it shows. */
    active?: string;
    /** Its normal (not maximized) bounds and the display they lie on. */
    bounds?: Rect;
    display?: number;
    maximized?: boolean;
}

/** The windows of one monitor setup as the session saves them. */
export interface SavedLayout {
    windows: AppWindow[];
    /** The displays when it was saved, to place windows whose display is gone on the primary one. */
    displays: DisplayInfo[];
    /** When it was last saved (ms), to pick the newest layout for a monitor setup that has none. */
    at: number;
}

/** Where a pane's view goes: the window, whether it is shown there, and whether it was moved in (a column of its own). */
export interface Placement {
    window: string;
    visible: boolean;
    moved: boolean;
}

/**
 * The windows of the app, pure state. Every workspace is in exactly one window (the main window unless moved),
 * every pane either lives with its repo (in the window that shows the repo, inside the repo's column) or was moved
 * into a window. `Workspaces.active` stays the workspace of the focused window, so every shortcut acts there.
 */
export class Windows {
    private readonly list: AppWindow[] = [{ id: MAIN, workspaces: [], panes: [] }];
    /** Window ids, the most recently focused first. */
    private order: string[] = [MAIN];

    all(): readonly AppWindow[] {
        return this.list;
    }

    get(id: string): AppWindow | undefined {
        return this.list.find(w => w.id === id);
    }

    main(): AppWindow {
        return this.list[0];
    }

    focused(): AppWindow {
        return this.get(this.order[0]) ?? this.main();
    }

    /** Window ids, the most recently focused first. */
    recent(): string[] {
        return [...this.order];
    }

    focus(id: string): boolean {
        if (!this.get(id) || this.order[0] === id) return false;
        this.order = [id, ...this.order.filter(w => w !== id)];
        return true;
    }

    /** The window holding a workspace: the one that lists it, else the main window. */
    ownerOf(workspace: string): AppWindow {
        const id = resolve(workspace);
        return this.list.find(w => w.workspaces.includes(id)) ?? this.main();
    }

    /** The window a pane was moved into; undefined while it lives with its repo. */
    windowOfPane(pane: string): AppWindow | undefined {
        return this.list.find(w => w.panes.includes(pane));
    }

    /** The workspaces a window holds, in the order of `open` (the rail order of every open workspace). */
    workspacesOf(id: string, open: readonly string[]): string[] {
        const window = this.get(id);
        return window ? open.filter(w => this.ownerOf(w) === window) : [];
    }

    /** The workspace a window shows: its active one while it still holds it, else the first it holds. */
    activeOf(id: string, open: readonly string[]): string | undefined {
        const held = this.workspacesOf(id, open);
        const window = this.get(id);
        return window?.active && held.includes(window.active) ? window.active : held[0];
    }

    /** Makes a workspace the shown one of the window holding it and focuses that window; returns the window. */
    follow(workspace: string): AppWindow {
        const window = this.ownerOf(workspace);
        window.active = resolve(workspace);
        this.focus(window.id);
        return window;
    }

    /** Opens a window with the given workspaces and panes, taken from the windows that held them, and focuses it. */
    open(contents: { workspaces?: string[], panes?: string[] }, bounds?: Rect): AppWindow {
        const workspaces = (contents.workspaces ?? []).map(w => resolve(w));
        const panes = contents.panes ?? [];
        for (const window of this.list) {
            window.workspaces = window.workspaces.filter(w => !workspaces.includes(w));
            window.panes = window.panes.filter(p => !panes.includes(p));
        }
        const window: AppWindow = { id: this.freeId(), workspaces, panes, active: workspaces[0], ...(bounds ? { bounds } : {}) };
        this.list.push(window);
        this.focus(window.id);
        return window;
    }

    /** Moves a workspace into a window (the main window takes it back); it becomes the shown one there. */
    moveWorkspace(workspace: string, to: string): boolean {
        const id = resolve(workspace);
        const target = this.get(to);
        if (!target || this.ownerOf(id) === target) return false;
        for (const window of this.list) window.workspaces = window.workspaces.filter(w => w !== id);
        if (target.id !== MAIN) target.workspaces.push(id);
        target.active = id;
        return true;
    }

    /** Moves a pane into a window, as a column at the end (before `before` when given). */
    movePane(pane: string, to: string, before?: string): boolean {
        const target = this.get(to);
        if (!target || !parsePane(pane) || (before === undefined && target.panes.at(-1) === pane)) return false;
        for (const window of this.list) window.panes = window.panes.filter(p => p !== pane);
        const at = before === undefined ? -1 : target.panes.indexOf(before);
        if (at < 0) target.panes.push(pane);
        else target.panes.splice(at, 0, pane);
        return true;
    }

    /** Sends a moved pane back to its repo's column, in whichever window shows the repo. */
    dockPane(pane: string): boolean {
        const window = this.windowOfPane(pane);
        if (!window) return false;
        window.panes = window.panes.filter(p => p !== pane);
        return true;
    }

    /**
     * Closes a window other than the main one: its workspaces go back to the main window, its panes back to their
     * repos, so closing a window never closes anything in it.
     */
    close(id: string): AppWindow | undefined {
        const at = this.list.findIndex(w => w.id === id);
        if (at <= 0) return undefined;
        const [window] = this.list.splice(at, 1);
        this.order = this.order.filter(w => w !== id);
        if (window.workspaces.length && !this.main().active) this.main().active = window.workspaces[0];
        return window;
    }

    /**
     * Forgets workspaces that were closed and panes whose repo has no server any more, then closes the windows other
     * than the main one that hold nothing. A moved pane of a live repo whose view does not exist yet (a terminal
     * restored before its view) stays in its window. Returns the closed window ids.
     */
    prune(open: readonly string[], live: ReadonlySet<string>): string[] {
        const closed: string[] = [];
        for (const window of [...this.list]) {
            window.workspaces = window.workspaces.filter(w => open.includes(w));
            window.panes = window.panes.filter(p => {
                const pane = parsePane(p);
                return pane !== undefined && live.has(pane.repo);
            });
            if (window.active && !open.includes(window.active)) window.active = undefined;
            if (window.id !== MAIN && !window.workspaces.length && !window.panes.length && this.close(window.id)) closed.push(window.id);
        }
        return closed;
    }

    /**
     * Where each pane goes. A moved pane is shown in its window. Every other pane goes to the window that shows its
     * repo; when two windows show the same repo (one folder in two workspaces), to the most recently focused one. A
     * pane whose repo no window shows stays hidden where it is (`previous`), so nothing moves needlessly.
     */
    placement(panes: readonly string[], shown: (window: string) => string | undefined, previous: ReadonlyMap<string, string> = new Map()): Map<string, Placement> {
        const result = new Map<string, Placement>();
        const repoOf = new Map(this.order.map(id => [id, shown(id)]));
        for (const pane of panes) {
            const ref = parsePane(pane);
            const moved = this.windowOfPane(pane);
            if (moved) {
                result.set(pane, { window: moved.id, visible: true, moved: true });
                continue;
            }
            const home = ref ? this.order.find(id => repoOf.get(id) === ref.repo) : undefined;
            const stay = previous.get(pane);
            result.set(pane, home
                ? { window: home, visible: true, moved: false }
                : { window: stay && this.get(stay) ? stay : MAIN, visible: false, moved: false });
        }
        return result;
    }

    /** The windows as a layout to save, with the displays of this monitor setup. */
    save(displays: readonly DisplayInfo[], at: number): SavedLayout {
        return { windows: structuredClone(this.list), displays: structuredClone([...displays]), at };
    }

    /**
     * Takes the windows of a saved layout (bounds as saved: place them with `placeWindow`). Workspaces that are not
     * open and panes of repos without a server are left out, and windows that hold nothing then are not opened.
     */
    restore(layout: SavedLayout, open: readonly string[], live: ReadonlySet<string>): void {
        const valid = (layout.windows ?? []).filter(w => w && typeof w.id === 'string');
        const main = valid.find(w => w.id === MAIN);
        this.list.splice(0, this.list.length, { ...clean(main ?? { id: MAIN, workspaces: [], panes: [] }), workspaces: [] });
        for (const window of valid) if (window.id !== MAIN && !this.get(window.id)) this.list.push(clean(window));
        this.order = [MAIN, ...this.list.slice(1).map(w => w.id)];
        this.prune(open, live);
    }

    /** Records where a window is now, after it was moved or resized. */
    setBounds(id: string, bounds: Rect, display: number | undefined, maximized: boolean): void {
        const window = this.get(id);
        if (window) Object.assign(window, { bounds, display, maximized });
    }

    private freeId(): string {
        for (let n = 2; ; n++) if (!this.get(`w${n}`)) return `w${n}`;
    }
}

/** A window from a session file: arrays of strings only, a workspace or pane in one window only. */
function clean(window: AppWindow): AppWindow {
    const strings = (list: unknown) => Array.isArray(list) ? [...new Set(list.filter((x): x is string => typeof x === 'string'))] : [];
    const rect = (r: Rect | undefined) => r && [r.x, r.y, r.width, r.height].every(n => Number.isFinite(n)) ? { x: r.x, y: r.y, width: r.width, height: r.height } : undefined;
    const bounds = rect(window.bounds);
    return {
        id: window.id, workspaces: strings(window.workspaces).map(w => resolve(w)), panes: strings(window.panes),
        ...(typeof window.active === 'string' ? { active: resolve(window.active) } : {}),
        ...(bounds ? { bounds } : {}),
        ...(typeof window.display === 'number' ? { display: window.display } : {}),
        ...(window.maximized === true ? { maximized: true } : {})
    };
}

/** How many monitor setups a session remembers layouts for. */
export const LAYOUTS = 8;

/** The layouts with the given one stored for its monitor setup; the oldest setups beyond `LAYOUTS` are dropped. */
export function rememberLayout(layouts: Record<string, SavedLayout>, layout: SavedLayout): Record<string, SavedLayout> {
    const all = { ...layouts, [displayFingerprint(layout.displays)]: layout };
    return Object.fromEntries(Object.entries(all).sort(([, a], [, b]) => b.at - a.at).slice(0, LAYOUTS));
}

/** The layout for a monitor setup: the one saved for it, else the newest of any setup (whose windows then fall back). */
export function layoutFor(layouts: Record<string, SavedLayout>, displays: readonly Pick<DisplayInfo, 'id' | 'bounds'>[]): SavedLayout | undefined {
    const exact = layouts[displayFingerprint(displays)];
    if (exact) return exact;
    return Object.values(layouts).filter(l => l && Array.isArray(l.windows)).sort((a, b) => b.at - a.at)[0];
}

/**
 * What a drag that left the rail ended on: another window of the app (its id), the window it started in (`undefined`:
 * nothing happens) or no window (`'new'`: the dragged item gets a window of its own there).
 */
export function dropTarget(point: { x: number, y: number }, from: string, windows: readonly { id: string, bounds: Rect }[]): string | 'new' | undefined {
    const inside = (r: Rect) => point.x >= r.x && point.x < r.x + r.width && point.y >= r.y && point.y < r.y + r.height;
    const hit = windows.find(w => inside(w.bounds));
    if (!hit) return 'new';
    return hit.id === from ? undefined : hit.id;
}

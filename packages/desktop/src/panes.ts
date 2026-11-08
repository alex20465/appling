import { resolve } from 'node:path';
import type { Rect } from './displays.js';

/**
 * A pane is one view of a repo that can live in any window: the repo view with the canvas (`ide`), and with the
 * features that follow a terminal, the code view or an agent session. Each pane is one kept alive `WebContentsView`;
 * moving it between windows moves that view, so it never reloads.
 *
 * Its id names its type, an optional key (several terminals of one repo) and its repo: `type:key:repo`, the key URI
 * encoded so the repo path (which may hold `:` on Windows) is the rest.
 */
export interface PaneRef {
    type: string;
    repo: string;
    key?: string;
}

export function paneId(type: string, repo: string, key?: string): string {
    return `${type}:${key === undefined ? '' : encodeURIComponent(key)}:${resolve(repo)}`;
}

export function parsePane(id: string): PaneRef | undefined {
    const match = /^([a-z][\w-]*):([^:]*):(.+)$/i.exec(id);
    if (!match) return undefined;
    const [, type, key, repo] = match;
    return { type, repo, ...(key ? { key: decodeURIComponent(key) } : {}) };
}

/**
 * Where a pane sits in the window that shows its repo: `main` fills the repo's column (one per repo, the repo view),
 * `bottom` panes share a strip below it (terminals), `side` panes share a strip on its right (code view, agents).
 * A pane moved into another window always gets a column of its own there.
 */
export type PaneRegion = 'main' | 'bottom' | 'side';

export interface PaneType {
    type: string;
    /** Shown in menus and on the rail of the window the pane was moved to, after the repo's name ("shop · Canvas"). */
    label: string;
    region: PaneRegion;
    /** The share of the repo's column its `bottom` or `side` strip takes (the first pane's type decides); default `STRIP`. */
    share?: number;
}

/** The repo view: the IDE client with the canvas, one per repo, always there while the repo's server runs. */
export const IDE_PANE = 'ide';

const types = new Map<string, PaneType>([[IDE_PANE, { type: IDE_PANE, label: 'Canvas', region: 'main' }]]);

/** Registers a pane type, so its panes get a label and a region. Registering a type again replaces it. */
export function registerPaneType(type: PaneType): void {
    types.set(type.type, type);
}

export function paneType(type: string): PaneType | undefined {
    return types.get(type);
}

/** The label of a pane, "Canvas", "Terminal 2"; the key is added to the type's label when there is one. */
export function paneLabel(id: string): string {
    const pane = parsePane(id);
    if (!pane) return id;
    const label = types.get(pane.type)?.label ?? pane.type;
    return pane.key ? `${label} ${pane.key}` : label;
}

/** The share of the repo's column a bottom or side strip takes. */
export const STRIP = 0.35;

/**
 * Lays out the area of a window right of the rail: the shown repo's column (its `main` pane, its `bottom` strip and its
 * `side` strip; `home`, in the repo's own order) and one column per pane moved into the window (`moved`), all of the
 * same width. Returns the bounds of every pane, relative to the window's content.
 */
export function layoutPanes(area: Rect, home: readonly string[], moved: readonly string[]): Map<string, Rect> {
    const bounds = new Map<string, Rect>();
    const columns = (home.length ? 1 : 0) + moved.length;
    if (!columns) return bounds;
    const width = Math.floor(area.width / columns);
    const column = (index: number): Rect => ({
        x: area.x + index * width, y: area.y, height: area.height,
        width: index === columns - 1 ? area.width - index * width : width
    });
    moved.forEach((id, index) => bounds.set(id, column(index + (home.length ? 1 : 0))));
    if (!home.length) return bounds;
    const type = (id: string) => types.get(parsePane(id)?.type ?? '');
    const region = (id: string) => type(id)?.region ?? 'main';
    const share = (ids: string[]) => type(ids[0])?.share ?? STRIP;
    const main = home.filter(id => region(id) === 'main');
    const bottom = home.filter(id => region(id) === 'bottom');
    const side = home.filter(id => region(id) === 'side');
    let rest = column(0);
    if (side.length && (main.length || bottom.length)) {
        const strip = Math.round(rest.width * share(side));
        split({ ...rest, x: rest.x + rest.width - strip, width: strip }, side, 'y', bounds);
        rest = { ...rest, width: rest.width - strip };
    } else if (side.length) {
        split(rest, side, 'y', bounds);
    }
    if (bottom.length && main.length) {
        const strip = Math.round(rest.height * share(bottom));
        split({ ...rest, y: rest.y + rest.height - strip, height: strip }, bottom, 'x', bounds);
        rest = { ...rest, height: rest.height - strip };
    } else if (bottom.length) {
        split(rest, bottom, 'x', bounds);
    }
    // a repo has one main pane; should there be more, they share the rest side by side
    if (main.length) split(rest, main, 'x', bounds);
    return bounds;
}

/** Splits a rectangle evenly along x (side by side) or y (stacked). */
function split(area: Rect, ids: readonly string[], axis: 'x' | 'y', into: Map<string, Rect>): void {
    const size = axis === 'x' ? area.width : area.height;
    const step = Math.floor(size / ids.length);
    ids.forEach((id, index) => {
        const length = index === ids.length - 1 ? size - index * step : step;
        into.set(id, axis === 'x'
            ? { ...area, x: area.x + index * step, width: length }
            : { ...area, y: area.y + index * step, height: length });
    });
}

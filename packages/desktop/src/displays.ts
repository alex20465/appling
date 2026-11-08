/** A rectangle in screen coordinates (Electron's `Rectangle`). */
export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** What the app keeps of a display (`screen.getAllDisplays()`): its id, its bounds and the part windows may use. */
export interface DisplayInfo {
    id: number;
    bounds: Rect;
    workArea: Rect;
}

/**
 * Names a monitor setup: the ids and bounds of every display, sorted by id. Plugging a monitor in or out, moving it
 * or changing its resolution gives another fingerprint, so window layouts are saved and restored per setup.
 */
export function displayFingerprint(displays: readonly Pick<DisplayInfo, 'id' | 'bounds'>[]): string {
    return [...displays].sort((a, b) => a.id - b.id)
        .map(({ id, bounds: { x, y, width, height } }) => `${id}@${x},${y},${width}x${height}`).join(';');
}

/** The area two rectangles share (0 when they do not overlap). */
export function overlap(a: Rect, b: Rect): number {
    const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    return width > 0 && height > 0 ? width * height : 0;
}

/** The display a rectangle lies on most; undefined when it is on none. */
export function displayOf(bounds: Rect, displays: readonly DisplayInfo[]): DisplayInfo | undefined {
    let best: DisplayInfo | undefined;
    let most = 0;
    for (const display of displays) {
        const area = overlap(bounds, display.workArea);
        if (area > most) [best, most] = [display, area];
    }
    return best;
}

/** How much of a window must stay on its display to be left where it is, in pixels each way. */
export const VISIBLE = 64;

/** Fits a rectangle into an area: no larger than the area, and moved inside it. */
export function clampInto(bounds: Rect, area: Rect): Rect {
    const width = Math.min(bounds.width, area.width);
    const height = Math.min(bounds.height, area.height);
    return {
        x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - width),
        y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - height),
        width, height
    };
}

/**
 * Where a saved window opens on the current displays. On its saved display (same id, still there) it keeps its bounds
 * as long as enough of it stays visible, else it is moved inside. A window whose display is gone falls back to the
 * primary display: at the same offset into the work area as on its old display (when that is known), else centered,
 * cascaded by `index` so several fallen back windows do not cover each other exactly.
 */
export function placeWindow(saved: { bounds: Rect, display?: number }, current: readonly DisplayInfo[], primary: number,
    before: readonly DisplayInfo[] = [], index = 0): { bounds: Rect, display: number } {
    const fallback = current.find(d => d.id === primary) ?? current[0];
    if (!fallback) return { bounds: saved.bounds, display: primary };
    const same = current.find(d => d.id === saved.display);
    if (same) {
        const { workArea: area } = same;
        const visible = Math.min(saved.bounds.x + saved.bounds.width, area.x + area.width) - Math.max(saved.bounds.x, area.x) >= VISIBLE
            && Math.min(saved.bounds.y + saved.bounds.height, area.y + area.height) - Math.max(saved.bounds.y, area.y) >= VISIBLE;
        return { bounds: visible ? saved.bounds : clampInto(saved.bounds, area), display: same.id };
    }
    const area = fallback.workArea;
    const old = before.find(d => d.id === saved.display);
    const cascade = 24 * index;
    const size = { width: Math.min(saved.bounds.width, area.width), height: Math.min(saved.bounds.height, area.height) };
    const at = old
        ? { x: area.x + saved.bounds.x - old.workArea.x + cascade, y: area.y + saved.bounds.y - old.workArea.y + cascade }
        : { x: area.x + Math.round((area.width - size.width) / 2) + cascade, y: area.y + Math.round((area.height - size.height) / 2) + cascade };
    return { bounds: clampInto({ ...at, ...size }, area), display: fallback.id };
}

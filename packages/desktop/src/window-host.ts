import { BaseWindow, screen, WebContentsView, type WebContents } from 'electron';
import type { DisplayInfo } from './displays.js';
import { layoutPanes } from './panes.js';
import { MAIN, Windows } from './windows.js';

export interface WindowHostOptions {
    /** The shell page (rail, switcher, empty states) every window loads first, under its panes. */
    shell: string;
    preload: string;
    /** The width of the rail now (0 while it is collapsed). */
    rail(): number;
    /** The repo a window shows (see `Windows.activeOf`). */
    shown(window: string): string | undefined;
    /** A window got the focus from the system. */
    onFocus(window: string): void;
    /** A window other than the main one is closing; its contents went back already. */
    onClosed(window: string): void;
    /** The main window is closing. */
    onMainClosed(): void;
    /** A window was moved or resized. */
    onMoved(window: string): void;
    /** Whether the app is quitting: windows closing then keep their contents, so the saved layout stays as it was. */
    quitting(): boolean;
}

interface Native {
    base: BaseWindow;
    shell: WebContentsView;
    /** What covers the panes with the shell page (the switcher, the clone form); while any does, they are hidden. */
    covers: Set<string>;
}

/**
 * The Electron side of `Windows`: one `BaseWindow` per window, each with its shell page and the views of the panes
 * placed in it. Moving a pane to another window moves its view with `removeChildView` and `addChildView`, so the page
 * in it never reloads. Kept thin; every decision is in `windows.ts` and `panes.ts`.
 */
export class WindowHost {
    readonly windows = new Windows();
    /** The view of every pane, by pane id, in the order they appeared (their order in the repo's column). */
    readonly panes = new Map<string, WebContentsView>();
    private readonly natives = new Map<string, Native>();
    /** The window each pane's view is a child of now. */
    private readonly where = new Map<string, string>();
    /** Windows the user is closing; they close themselves. */
    private readonly closing = new Set<string>();
    /** Panes that are not shown anywhere for now (see `setHidden`). */
    private readonly hidden = new Set<string>();

    constructor(private readonly options: WindowHostOptions) {}

    native(id: string): Native | undefined {
        return this.natives.get(id);
    }

    base(id: string = this.windows.focused().id): BaseWindow | undefined {
        return (this.natives.get(id) ?? this.natives.get(MAIN))?.base;
    }

    /** The window whose shell page sent an IPC message. */
    idOf(contents: WebContents): string | undefined {
        for (const [id, native] of this.natives) if (native.shell.webContents === contents) return id;
        return undefined;
    }

    shells(): [string, WebContents][] {
        return [...this.natives].map(([id, native]) => [id, native.shell.webContents]);
    }

    /** Registers a pane's view; `arrange` puts it into its window. */
    addPane(id: string, view: WebContentsView): void {
        this.panes.set(id, view);
    }

    /** Takes a pane's view out of its window and forgets it; the caller closes its web contents. */
    removePane(id: string): WebContentsView | undefined {
        const view = this.panes.get(id);
        if (!view) return undefined;
        this.natives.get(this.where.get(id) ?? '')?.base.contentView.removeChildView(view);
        this.panes.delete(id);
        this.where.delete(id);
        return view;
    }

    /** The window a pane's view is in now, and whether it is shown. */
    paneWindow(id: string): string | undefined {
        return this.where.get(id);
    }

    /** Covers a window's panes with its shell page for `what` (the switcher, a form), or uncovers them; false when nothing changed. */
    cover(id: string, what: string, on: boolean): boolean {
        const native = this.natives.get(id);
        if (!native || native.covers.has(what) === on) return false;
        if (on) native.covers.add(what);
        else native.covers.delete(what);
        return true;
    }

    covered(id: string, what: string): boolean {
        return this.natives.get(id)?.covers.has(what) ?? false;
    }

    isHidden(id: string): boolean {
        return this.hidden.has(id);
    }

    /** Hides a pane wherever it is (a closed code view), so the others take its place; its view stays alive. */
    setHidden(id: string, hidden: boolean): void {
        if (hidden) this.hidden.add(id);
        else this.hidden.delete(id);
    }

    /** Raises a window and gives it the focus. */
    show(id: string): void {
        const base = this.natives.get(id)?.base;
        if (!base || base.isDestroyed()) return;
        if (base.isMinimized()) base.restore();
        base.focus();
    }

    /** The bounds of every window, the most recently focused first (about their stacking order). */
    bounds(): { id: string, bounds: ReturnType<BaseWindow['getBounds']> }[] {
        return this.windows.recent().flatMap(id => {
            const base = this.natives.get(id)?.base;
            return base && !base.isDestroyed() ? [{ id, bounds: base.getBounds() }] : [];
        });
    }

    /**
     * Brings the native windows in line with `windows`: opens the missing ones, moves every pane's view into its
     * window, lays them out and shows the visible ones, then closes the windows that are gone (empty by then).
     */
    arrange(): void {
        for (const window of this.windows.all()) if (!this.natives.has(window.id)) this.create(window.id);
        const placement = this.windows.placement([...this.panes.keys()], id => this.options.shown(id), this.where);
        for (const [pane, place] of placement) {
            const view = this.panes.get(pane)!;
            const from = this.where.get(pane);
            if (from === place.window) continue;
            if (from) this.natives.get(from)?.base.contentView.removeChildView(view);
            this.natives.get(place.window)!.base.contentView.addChildView(view);
            this.where.set(pane, place.window);
        }
        for (const [id, native] of this.natives) {
            if (!this.windows.get(id)) continue;
            const [width, height] = native.base.getContentSize();
            native.shell.setBounds({ x: 0, y: 0, width, height });
            const rail = this.options.rail();
            const here = [...placement].filter(([, p]) => p.window === id);
            const home = here.filter(([pane, p]) => p.visible && !p.moved && !this.hidden.has(pane)).map(([pane]) => pane);
            const moved = this.windows.get(id)!.panes.filter(pane => this.panes.has(pane) && !this.hidden.has(pane));
            const bounds = layoutPanes({ x: rail, y: 0, width: Math.max(0, width - rail), height }, home, moved);
            for (const [pane, place] of here) {
                const view = this.panes.get(pane)!;
                const rect = bounds.get(pane);
                if (rect) view.setBounds(rect);
                view.setVisible(place.visible && !!rect && !native.covers.size && !this.hidden.has(pane));
            }
        }
        for (const [id, native] of [...this.natives]) {
            if (this.windows.get(id)) continue;
            this.natives.delete(id);
            if (!native.base.isDestroyed() && !this.closing.has(id)) native.base.close();
        }
    }

    send(id: string, channel: string, ...args: unknown[]): void {
        const native = this.natives.get(id);
        if (native && !native.shell.webContents.isDestroyed()) native.shell.webContents.send(channel, ...args);
    }

    private create(id: string): Native {
        const window = this.windows.get(id)!;
        const base = new BaseWindow({
            ...(window.bounds ?? { width: 1440, height: 900 }),
            minWidth: 640, minHeight: 400, title: 'Appling', backgroundColor: '#0c0a08', show: false
        });
        const shell = new WebContentsView({ webPreferences: { preload: this.options.preload, contextIsolation: true, sandbox: true, nodeIntegration: false } });
        shell.setBackgroundColor('#0c0a08');
        shell.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        shell.webContents.on('will-navigate', event => event.preventDefault());
        base.contentView.addChildView(shell);
        const native: Native = { base, shell, covers: new Set() };
        this.natives.set(id, native);
        shell.webContents.once('did-finish-load', () => {
            if (base.isDestroyed()) return;
            if (window.maximized) base.maximize();
            base.show();
            moved();
        });
        shell.webContents.loadFile(this.options.shell);
        const moved = () => {
            if (base.isDestroyed() || !this.windows.get(id)) return;
            const bounds = base.getNormalBounds();
            this.windows.setBounds(id, bounds, screen.getDisplayMatching(bounds).id, base.isMaximized());
            this.options.onMoved(id);
        };
        base.on('resize', () => {
            this.arrange();
            moved();
        });
        base.on('move', moved);
        base.on('focus', () => this.options.onFocus(id));
        base.on('close', () => {
            if (this.options.quitting()) return;
            if (id === MAIN) return this.options.onMainClosed();
            // the contents go back before the window is gone, so their views are never destroyed with it
            this.closing.add(id);
            if (this.windows.close(id)) {
                this.arrange();
                this.options.onClosed(id);
            }
        });
        base.on('closed', () => {
            this.closing.delete(id);
            this.natives.delete(id);
            if (!shell.webContents.isDestroyed()) shell.webContents.close();
        });
        return native;
    }
}

/** The displays now, as `displays.ts` takes them. */
export function currentDisplays(): DisplayInfo[] {
    return screen.getAllDisplays().map(({ id, bounds, workArea }) => ({ id, bounds, workArea }));
}

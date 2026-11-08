import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { clampInto, displayFingerprint, displayOf, placeWindow, type DisplayInfo } from '../src/displays.js';
import { IDE_PANE, layoutPanes, paneId, paneLabel, parsePane, registerPaneType } from '../src/panes.js';
import { readSession, sessionOf, writeSession } from '../src/session.js';
import { dropTarget, LAYOUTS, layoutFor, MAIN, rememberLayout, Windows } from '../src/windows.js';
import { Workspaces } from '../src/workspaces.js';

const display = (id: number, x: number, y: number, width = 1920, height = 1080): DisplayInfo =>
    ({ id, bounds: { x, y, width, height }, workArea: { x, y: y + 32, width, height: height - 32 } });
const laptop = display(1, 0, 0);
const monitor = display(2, 1920, 0, 2560, 1440);

test('a monitor setup is named by its display ids and bounds, in any order', () => {
    expect(displayFingerprint([monitor, laptop])).toBe(displayFingerprint([laptop, monitor]));
    expect(displayFingerprint([laptop])).toBe('1@0,0,1920x1080');
    expect(displayFingerprint([laptop, { ...monitor, bounds: { ...monitor.bounds, x: -2560 } }])).not.toBe(displayFingerprint([laptop, monitor]));
    expect(displayOf({ x: 2000, y: 100, width: 800, height: 600 }, [laptop, monitor])?.id).toBe(2);
    expect(displayOf({ x: 1800, y: 100, width: 400, height: 600 }, [laptop, monitor])?.id).toBe(2);
    expect(displayOf({ x: -5000, y: 0, width: 10, height: 10 }, [laptop, monitor])).toBeUndefined();
    expect(clampInto({ x: 1800, y: -50, width: 3000, height: 500 }, laptop.workArea)).toEqual({ x: 0, y: 32, width: 1920, height: 500 });
});

test('a window keeps its place on its display and falls back to the primary display when that is gone', () => {
    const onMonitor = { bounds: { x: 2100, y: 100, width: 1200, height: 800 }, display: 2 };
    expect(placeWindow(onMonitor, [laptop, monitor], 1)).toEqual(onMonitor);
    // pushed almost off its display, it is moved back inside
    expect(placeWindow({ bounds: { x: 4450, y: 100, width: 1200, height: 800 }, display: 2 }, [laptop, monitor], 1).bounds)
        .toEqual({ x: 1920 + 2560 - 1200, y: 100, width: 1200, height: 800 });
    // the monitor is gone: same offset into the primary display's work area, the size fitted into it
    expect(placeWindow(onMonitor, [laptop], 1, [laptop, monitor])).toEqual({ bounds: { x: 180, y: 100, width: 1200, height: 800 }, display: 1 });
    expect(placeWindow({ bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, display: 2 }, [laptop], 1, [laptop, monitor]))
        .toEqual({ bounds: { x: 0, y: 32, width: 1920, height: 1048 }, display: 1 });
    // without the old displays it is centered, cascaded by its index
    expect(placeWindow(onMonitor, [laptop], 1, [], 1)).toEqual({ bounds: { x: 360 + 24, y: 32 + 124 + 24, width: 1200, height: 800 }, display: 1 });
    // an unknown primary id takes the first display
    expect(placeWindow(onMonitor, [laptop], 9).display).toBe(1);
});

test('pane ids name a type, a key and a repo, and keep paths with colons and hashes', () => {
    const id = paneId('terminal', '/work/shop#1', 'a:b c');
    expect(parsePane(id)).toEqual({ type: 'terminal', repo: resolve('/work/shop#1'), key: 'a:b c' });
    expect(parsePane(paneId(IDE_PANE, '/work/shop/'))).toEqual({ type: 'ide', repo: resolve('/work/shop') });
    expect(parsePane('C:\\work')).toBeUndefined();
    expect(paneLabel(paneId(IDE_PANE, '/work/shop'))).toBe('Canvas');
    registerPaneType({ type: 'terminal', label: 'Terminal', region: 'bottom' });
    expect(paneLabel(paneId('terminal', '/work/shop', '2'))).toBe('Terminal 2');
    expect(paneLabel(paneId('unknown', '/work/shop'))).toBe('unknown');
});

test('a window lays out its repo column (main, bottom and side panes) and a column per moved pane', () => {
    registerPaneType({ type: 'terminal', label: 'Terminal', region: 'bottom' });
    registerPaneType({ type: 'code', label: 'Code', region: 'side' });
    const area = { x: 48, y: 0, width: 1200, height: 800 };
    const canvas = paneId(IDE_PANE, '/a');
    const terminal = paneId('terminal', '/a', '1');
    const code = paneId('code', '/a');
    const other = paneId(IDE_PANE, '/b');
    expect(layoutPanes(area, [canvas], [])).toEqual(new Map([[canvas, area]]));
    expect(layoutPanes(area, [], [])).toEqual(new Map());
    expect(layoutPanes(area, [canvas], [other])).toEqual(new Map([
        [other, { x: 648, y: 0, width: 600, height: 800 }],
        [canvas, { x: 48, y: 0, width: 600, height: 800 }]
    ]));
    const full = layoutPanes(area, [canvas, terminal, code], []);
    expect(full.get(code)).toEqual({ x: 48 + 780, y: 0, width: 420, height: 800 });
    expect(full.get(terminal)).toEqual({ x: 48, y: 520, width: 780, height: 280 });
    expect(full.get(canvas)).toEqual({ x: 48, y: 0, width: 780, height: 520 });
    registerPaneType({ type: 'code', label: 'Code', region: 'side', share: 0.5 });
    expect(layoutPanes(area, [canvas, code], []).get(code)).toEqual({ x: 648, y: 0, width: 600, height: 800 });
    // a column of moved panes only, three of them split the width with the remainder in the last
    const moved = layoutPanes({ x: 0, y: 0, width: 1000, height: 600 }, [], [canvas, other, terminal]);
    expect([...moved.values()].map(r => r.width)).toEqual([333, 333, 334]);
    // bottom panes without a main pane fill the column side by side
    expect(layoutPanes(area, [terminal, paneId('terminal', '/a', '2')], []).get(terminal)).toEqual({ x: 48, y: 0, width: 600, height: 800 });
});

const A = resolve('/ws/a.code-workspace');
const B = resolve('/ws/b.code-workspace');
const C = resolve('/ws/c.code-workspace');

test('workspaces stay in the main window until moved; a window shows its active workspace or its first one', () => {
    const windows = new Windows();
    const open = [A, B, C];
    expect(windows.workspacesOf(MAIN, open)).toEqual(open);
    const second = windows.open({ workspaces: [B] });
    expect(second.id).toBe('w2');
    expect(windows.focused()).toBe(second);
    expect(windows.ownerOf(B)).toBe(second);
    expect(windows.workspacesOf(MAIN, open)).toEqual([A, C]);
    expect(windows.activeOf('w2', open)).toBe(B);
    expect(windows.activeOf(MAIN, open)).toBe(A);
    windows.get(MAIN)!.active = C;
    expect(windows.activeOf(MAIN, open)).toBe(C);

    expect(windows.moveWorkspace(C, 'w2')).toBe(true);
    expect(windows.moveWorkspace(C, 'w2')).toBe(false);
    expect(windows.workspacesOf('w2', open)).toEqual([B, C]);
    expect(windows.activeOf('w2', open)).toBe(C);
    // the main window's active workspace moved away: it shows its first one
    expect(windows.activeOf(MAIN, open)).toBe(A);

    expect(windows.follow(A)).toBe(windows.main());
    expect(windows.focused().id).toBe(MAIN);
    expect(windows.recent()).toEqual([MAIN, 'w2']);
    // dock it back: the main window takes the workspace
    expect(windows.moveWorkspace(B, MAIN)).toBe(true);
    expect(windows.ownerOf(B).id).toBe(MAIN);
    expect(windows.activeOf(MAIN, open)).toBe(B);
});

test('panes move between windows and dock back; closing a window gives everything back', () => {
    const windows = new Windows();
    const canvas = paneId(IDE_PANE, '/a');
    const terminal = paneId('terminal', '/a', '1');
    const w2 = windows.open({ panes: [canvas] });
    expect(windows.windowOfPane(canvas)).toBe(w2);
    const w3 = windows.open({ workspaces: [A], panes: [canvas] });
    expect(w3.id).toBe('w3');
    expect(windows.windowOfPane(canvas)).toBe(w3);
    expect(w2.panes).toEqual([]);
    expect(windows.movePane(terminal, 'w3', canvas)).toBe(true);
    expect(w3.panes).toEqual([terminal, canvas]);
    expect(windows.movePane(canvas, 'w3')).toBe(false);
    expect(windows.movePane('nonsense', 'w3')).toBe(false);
    expect(windows.movePane(canvas, 'w9')).toBe(false);
    expect(windows.dockPane(terminal)).toBe(true);
    expect(windows.dockPane(terminal)).toBe(false);

    // w2 holds nothing now: pruning closes it, and frees its id for the next window
    expect(windows.prune([A], new Set(['/a'].map(p => resolve(p))))).toEqual(['w2']);
    expect(windows.open({}).id).toBe('w2');
    expect(windows.close(MAIN)).toBeUndefined();
    expect(windows.close('w3')?.workspaces).toEqual([A]);
    expect(windows.ownerOf(A).id).toBe(MAIN);
    expect(windows.main().active).toBe(A);
    expect(windows.windowOfPane(canvas)).toBeUndefined();
    expect(windows.recent()).toEqual(['w2', MAIN]);
});

test('pruning forgets closed workspaces and panes of repos without a server', () => {
    const windows = new Windows();
    windows.open({ workspaces: [A], panes: [paneId(IDE_PANE, '/gone')] });
    windows.open({ panes: [paneId('terminal', '/a', '1')] });
    expect(windows.prune([B], new Set([resolve('/a')]))).toEqual(['w2']);
    expect(windows.all().map(w => w.id)).toEqual([MAIN, 'w3']);
    // a pane whose view is not there yet (a terminal restored before it started) stays
    expect(windows.get('w3')!.panes).toEqual([paneId('terminal', '/a', '1')]);
});

test('every pane goes to the window that shows its repo, the most recently focused one first, or to the window it was moved to', () => {
    const windows = new Windows();
    const a = paneId(IDE_PANE, '/a');
    const b = paneId(IDE_PANE, '/b');
    const terminal = paneId('terminal', '/a', '1');
    const c = paneId(IDE_PANE, '/c');
    windows.open({ workspaces: [B] });
    const shown: Record<string, string> = { [MAIN]: resolve('/a'), w2: resolve('/b') };
    let placement = windows.placement([a, b, terminal, c], id => shown[id]);
    expect(placement.get(a)).toEqual({ window: MAIN, visible: true, moved: false });
    expect(placement.get(terminal)).toEqual({ window: MAIN, visible: true, moved: false });
    expect(placement.get(b)).toEqual({ window: 'w2', visible: true, moved: false });
    // shown nowhere: it stays hidden where it was
    expect(windows.placement([c], id => shown[id], new Map([[c, 'w2']])).get(c)).toEqual({ window: 'w2', visible: false, moved: false });
    expect(windows.placement([c], id => shown[id], new Map([[c, 'w7']])).get(c)).toEqual({ window: MAIN, visible: false, moved: false });

    // both windows show /a (one folder in two workspaces): the focused one gets it
    shown.w2 = resolve('/a');
    expect(windows.placement([a], id => shown[id]).get(a)?.window).toBe('w2');
    windows.focus(MAIN);
    expect(windows.placement([a], id => shown[id]).get(a)?.window).toBe(MAIN);

    // the canvas moved into the second window stays there and is shown, the terminal stays with the repo
    windows.movePane(a, 'w2');
    shown.w2 = resolve('/b');
    placement = windows.placement([a, terminal], id => shown[id]);
    expect(placement.get(a)).toEqual({ window: 'w2', visible: true, moved: true });
    expect(placement.get(terminal)).toEqual({ window: MAIN, visible: true, moved: false });
});

test('a drag that leaves the rail lands in another window, in its own window or in a new one', () => {
    const windows = [{ id: MAIN, bounds: { x: 0, y: 0, width: 1000, height: 800 } }, { id: 'w2', bounds: { x: 1200, y: 0, width: 800, height: 600 } }];
    expect(dropTarget({ x: 1300, y: 100 }, MAIN, windows)).toBe('w2');
    expect(dropTarget({ x: 500, y: 100 }, MAIN, windows)).toBeUndefined();
    expect(dropTarget({ x: 1100, y: 100 }, MAIN, windows)).toBe('new');
    expect(dropTarget({ x: 1000, y: 100 }, 'w2', windows)).toBe('new');
});

test('layouts are saved per monitor setup, restored for it, and the newest one serves a new setup', () => {
    const windows = new Windows();
    windows.open({ workspaces: [B], panes: [paneId(IDE_PANE, '/a')] }, { x: 2000, y: 100, width: 1200, height: 800 });
    windows.setBounds('w2', { x: 2000, y: 100, width: 1200, height: 800 }, 2, true);
    windows.get(MAIN)!.active = A;
    let layouts = rememberLayout({}, windows.save([laptop, monitor], 2));
    layouts = rememberLayout(layouts, new Windows().save([laptop], 1));
    expect(Object.keys(layouts)).toEqual([displayFingerprint([laptop, monitor]), displayFingerprint([laptop])]);
    expect(layoutFor(layouts, [monitor, laptop])?.at).toBe(2);
    expect(layoutFor(layouts, [laptop])?.at).toBe(1);
    expect(layoutFor(layouts, [display(7, 0, 0, 800, 600)])?.at).toBe(2);
    expect(layoutFor({}, [laptop])).toBeUndefined();
    for (let at = 3; at < 3 + LAYOUTS; at++) layouts = rememberLayout(layouts, new Windows().save([display(at, 0, 0)], at));
    expect(Object.keys(layouts)).toHaveLength(LAYOUTS);
    expect(layouts[displayFingerprint([laptop])]).toBeUndefined();

    const restored = new Windows();
    restored.restore(layoutFor(rememberLayout({}, windows.save([laptop, monitor], 2)), [laptop, monitor])!, [A, B], new Set([resolve('/a')]));
    expect(restored.all().map(w => w.id)).toEqual([MAIN, 'w2']);
    expect(restored.get('w2')).toEqual({ id: 'w2', workspaces: [B], panes: [paneId(IDE_PANE, '/a')], active: B, bounds: { x: 2000, y: 100, width: 1200, height: 800 }, display: 2, maximized: true });
    expect(restored.activeOf(MAIN, [A, B])).toBe(A);

    // a workspace that did not reopen and a repo without a server: the window holds nothing, so it is not opened
    const empty = new Windows();
    empty.restore(windows.save([laptop], 3), [A], new Set());
    expect(empty.all().map(w => w.id)).toEqual([MAIN]);
    // broken entries from a hand edited session are skipped
    const broken = new Windows();
    broken.restore({ windows: [null, { id: 'w5', workspaces: [A, 7, A], panes: 'x', bounds: { x: 'a' } }] as never, displays: [], at: 0 }, [A], new Set());
    expect(broken.get('w5')).toEqual({ id: 'w5', workspaces: [A], panes: [] });
});

test('the session saves the window layouts and reads old sessions without them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'appling-desktop-'));
    const file = join(dir, 'session.json');
    const workspaces = new Workspaces();
    const windows = new Windows();
    windows.open({ panes: [paneId(IDE_PANE, '/a')] });
    const layouts = rememberLayout({}, windows.save([laptop], 5));
    writeSession(file, sessionOf(workspaces, layouts));
    expect(readSession(file)?.layouts).toEqual(layouts);
    writeFileSync(file, JSON.stringify({ workspaces: [] }));
    expect(readSession(file)?.layouts).toEqual({});
    writeFileSync(file, JSON.stringify({ workspaces: [], layouts: [] }));
    expect(readSession(file)?.layouts).toEqual({});
});

import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { readCodeWorkspace, workspaceName, writeCodeWorkspace } from '../src/code-workspace.js';
import { startIdeProcess, type IdeProcess } from '../src/ide-process.js';
import { DEFAULT_KEYBINDINGS, loadKeybindings } from '../src/keybindings.js';
import { Repos } from '../src/repos.js';
import { readSession, restore, sessionOf, writeSession } from '../src/session.js';
import { fuzzyMatch, switcherEntries } from '../src/switcher.js';
import { WALK_MS, Workspaces } from '../src/workspaces.js';

test('a folder registered twice stays one repo', () => {
    const repos = new Repos();
    expect(repos.add('/work/shop').added).toBe(true);
    expect(repos.add('/work/crm').added).toBe(true);
    expect(repos.add('/work/shop/').added).toBe(false);
    expect(repos.all().map(r => r.name)).toEqual(['shop', 'crm']);
    expect(repos.close('/work/shop')?.name).toBe('shop');
    expect(repos.get('/work/shop')).toBeUndefined();
});

const folders = (...paths: string[]) => paths.map(path => ({ path }));

test('workspaces hold repos, a folder in two workspaces is one live repo, closing passes to the neighbour', () => {
    const workspaces = new Workspaces();
    expect(workspaces.open('/ws/client.code-workspace', folders('/a', '/b', '/a/')).added).toBe(true);
    expect(workspaces.current()?.name).toBe('client');
    expect(workspaces.current()?.folders.map(f => f.path)).toEqual(['/a', '/b']);
    expect(workspaces.activeRepo()).toBe('/a');
    workspaces.open('/ws/product.code-workspace', folders('/b', '/c'));
    expect(workspaces.live()).toEqual(new Set(['/a', '/b', '/c']));
    expect(workspaces.open('/ws/client.code-workspace', []).added).toBe(false);
    expect(workspaces.active).toBe('/ws/client.code-workspace');

    expect(workspaces.select('/b')).toBe(true);
    expect(workspaces.active).toBe('/ws/client.code-workspace');
    expect(workspaces.select('/c')).toBe(true);
    expect(workspaces.active).toBe('/ws/product.code-workspace');
    expect(workspaces.select('/nowhere')).toBe(false);

    expect(workspaces.removeRepo('/ws/product.code-workspace', '/c')).toBe(true);
    expect(workspaces.activeRepo()).toBe('/b');
    expect(workspaces.live()).toEqual(new Set(['/a', '/b']));
    workspaces.close('/ws/product.code-workspace');
    expect(workspaces.active).toBe('/ws/client.code-workspace');
    workspaces.close('/ws/client.code-workspace');
    expect(workspaces.active).toBeUndefined();
    expect(workspaces.live().size).toBe(0);
});

test('repos are added to and moved between workspaces, and reached by position', () => {
    const workspaces = new Workspaces();
    workspaces.open('/ws/one.code-workspace', [{ path: '/a', name: 'Alpha' }]);
    workspaces.open('/ws/two.code-workspace', []);
    expect(workspaces.addRepo('/ws/two.code-workspace', '/b')).toBe(true);
    expect(workspaces.addRepo('/ws/two.code-workspace', '/b')).toBe(false);
    expect(workspaces.moveRepo('/a', '/ws/one.code-workspace', '/ws/two.code-workspace')).toBe(true);
    expect(workspaces.get('/ws/one.code-workspace')?.folders).toEqual([]);
    expect(workspaces.get('/ws/two.code-workspace')?.folders).toEqual([{ path: '/b' }, { path: '/a', name: 'Alpha' }]);
    expect(workspaces.activeRepo()).toBe('/a');
    expect(workspaces.moveRepo('/a', '/ws/two.code-workspace', '/ws/two.code-workspace')).toBe(false);
    expect(workspaces.selectAt(0)).toBe(true);
    expect(workspaces.activeRepo()).toBe('/b');
    expect(workspaces.selectAt(5)).toBe(false);
    expect(workspaces.selectWorkspaceAt(0)).toBe(true);
    expect(workspaces.active).toBe('/ws/one.code-workspace');
    workspaces.cycleWorkspace(-1);
    expect(workspaces.active).toBe('/ws/two.code-workspace');
    workspaces.cycleWorkspace(1);
    expect(workspaces.active).toBe('/ws/one.code-workspace');
});

test('Ctrl+Tab walks the repos of every workspace in most recently used order', () => {
    const workspaces = new Workspaces();
    workspaces.open('/ws/one.code-workspace', folders('/a', '/b'));
    workspaces.open('/ws/two.code-workspace', folders('/c'));
    workspaces.select('/b');
    workspaces.select('/a');
    expect(workspaces.mostRecent()).toEqual(['/a', '/b', '/c']);
    // one press toggles between the last two
    expect(workspaces.stepRecent(1, 0)).toBe(true);
    expect(workspaces.activeRepo()).toBe('/b');
    expect(workspaces.stepRecent(1, 10_000)).toBe(true);
    expect(workspaces.activeRepo()).toBe('/a');
    // quick presses go further along the same order, across workspaces
    workspaces.stepRecent(1, 20_000);
    workspaces.stepRecent(1, 20_000 + WALK_MS / 2);
    expect(workspaces.activeRepo()).toBe('/c');
    expect(workspaces.active).toBe('/ws/two.code-workspace');
    expect(workspaces.mostRecent()[0]).toBe('/c');
    workspaces.stepRecent(-1, 20_000 + WALK_MS);
    expect(workspaces.activeRepo()).toBe('/b');
});

test('repos are pinned to the top, hidden from the rail and Ctrl+1..9, and reordered by a drop', () => {
    const workspaces = new Workspaces();
    const ws = '/ws/one.code-workspace';
    workspaces.open(ws, folders('/a', '/b', '/c', '/d'));
    const rail = () => workspaces.rail(ws).map(f => f.path);
    expect(workspaces.pin(ws, '/c', true)).toBe(true);
    expect(workspaces.pin(ws, '/c', true)).toBe(false);
    expect(workspaces.pin(ws, '/nowhere', true)).toBe(false);
    expect(rail()).toEqual(['/c', '/a', '/b', '/d']);
    expect(workspaces.selectAt(0)).toBe(true);
    expect(workspaces.activeRepo()).toBe('/c');

    // hiding the shown repo shows its rail neighbour; the hidden one keeps running and is still selectable
    expect(workspaces.hide(ws, '/c', true)).toBe(true);
    expect(workspaces.get(ws)?.pinned).toEqual([]);
    expect(workspaces.activeRepo()).toBe('/a');
    expect(rail()).toEqual(['/a', '/b', '/d']);
    expect(workspaces.live().has('/c')).toBe(true);
    workspaces.selectAt(2);
    expect(workspaces.activeRepo()).toBe('/d');
    expect(workspaces.select('/c')).toBe(true);
    // pinning shows a hidden repo again
    expect(workspaces.pin(ws, '/c', true)).toBe(true);
    expect(workspaces.get(ws)?.hidden).toEqual([]);

    // a drop moves the folder (and so the file's order) and joins the group it lands in
    expect(workspaces.reorder(ws, '/d', '/c')).toBe(true);
    expect(workspaces.get(ws)?.folders.map(f => f.path)).toEqual(['/a', '/b', '/d', '/c']);
    expect(workspaces.get(ws)?.pinned).toEqual(['/d', '/c']);
    expect(rail()).toEqual(['/d', '/c', '/a', '/b']);
    expect(workspaces.reorder(ws, '/c', '/a')).toBe(true);
    expect(rail()).toEqual(['/d', '/c', '/a', '/b']);
    expect(workspaces.get(ws)?.pinned).toEqual(['/d']);
    expect(workspaces.reorder(ws, '/d')).toBe(true);
    expect(rail()).toEqual(['/c', '/a', '/b', '/d']);
    expect(workspaces.reorder(ws, '/d', '/d')).toBe(false);
    expect(workspaces.reorder(ws, '/d', '/nowhere')).toBe(false);

    // removing a repo forgets its pin
    workspaces.pin(ws, '/a', true);
    workspaces.hide(ws, '/b', true);
    workspaces.removeRepo(ws, '/a');
    workspaces.removeRepo(ws, '/b');
    expect(workspaces.get(ws)).toMatchObject({ pinned: [], hidden: [] });
});

test('the fuzzy match prefers word starts and runs, and finds every character in order', () => {
    expect(fuzzyMatch('', 'anything')).toEqual({ score: 0, positions: [] });
    expect(fuzzyMatch('xyz', 'appling')).toBeUndefined();
    expect(fuzzyMatch('ai', 'appling-ai')?.positions).toEqual([8, 9]);
    expect(fuzzyMatch('ws', 'appling-workspace-switcher')?.positions).toEqual([8, 18]);
    expect(fuzzyMatch('wS', 'myWorkSpace')?.positions).toEqual([2, 6]);
    expect(fuzzyMatch('bc', 'xbc-b')?.positions).toEqual([1, 2]);
    expect(fuzzyMatch('a p', 'appling')?.positions).toEqual([0, 1]);
    expect(fuzzyMatch('shop', 'shop')!.score).toBeGreaterThan(fuzzyMatch('shop', 'workshop')!.score);
    expect(fuzzyMatch('shop', 'shop')!.score).toBeGreaterThan(fuzzyMatch('shop', 'shop-legacy')!.score);
});

test('the switcher lists every repo of every workspace: recent first without a query, best match with one', () => {
    const workspaces = new Workspaces();
    workspaces.open('/ws/client.code-workspace', [{ path: '/work/shop' }, { path: '/work/crm', name: 'CRM' }]);
    workspaces.open('/ws/product.code-workspace', folders('/work/shop-api', '/work/billing'));
    workspaces.hide('/ws/product.code-workspace', '/work/billing', true);
    workspaces.select('/work/shop-api');
    workspaces.select('/work/crm');
    const name = (path: string, folderName?: string) => folderName ?? path.split('/').pop()!;
    const lines = (query: string) => switcherEntries(workspaces, name, query).map(e => `${e.workspaceName}:${e.name}`);

    expect(lines('')).toEqual(['product:shop-api', 'client:shop', 'product:billing', 'client:CRM']);
    expect(switcherEntries(workspaces, name, '').at(-1)).toMatchObject({ active: true, repo: '/work/crm' });
    expect(switcherEntries(workspaces, name, 'bil')[0]).toMatchObject({ hidden: true, positions: [0, 1, 2] });
    expect(lines('shop')).toEqual(['client:shop', 'product:shop-api']);
    expect(lines('sa')).toEqual(['product:shop-api']);
    // the workspace name matches too, below the repo names
    expect(lines('product')).toEqual(['product:billing', 'product:shop-api']);
    expect(lines('client crm')[0]).toBe('client:CRM');
    expect(lines('zzz')).toEqual([]);
});

test('workspace files read like VS Code: comments, trailing commas, relative paths, names and remote folders', () => {
    const dir = mkdtempSync(join(tmpdir(), 'appling-desktop-'));
    const file = join(dir, 'client.code-workspace');
    writeFileSync(file, [
        '{',
        '  // the repos of the client',
        '  "folders": [',
        '    { "path": "shop", "name": "Shop // web" },',
        '    { "path": "../crm", },',
        '    { "uri": "vscode-remote://ssh-remote+box/srv/api" },',
        '  ],',
        '  /* kept */ "settings": { "editor.tabSize": 2, "url": "http://x/*y*/" },',
        '}'
    ].join('\n'));
    const workspace = readCodeWorkspace(file);
    expect(workspaceName(file)).toBe('client');
    expect(workspace.folders).toEqual([{ path: join(dir, 'shop'), name: 'Shop // web' }, { path: resolve(dir, '../crm') }]);
    expect(workspace.data).toEqual({ settings: { 'editor.tabSize': 2, url: 'http://x/*y*/' } });

    writeCodeWorkspace(file, [...workspace.folders, { path: join(dir, 'docs') }]);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
        folders: [{ name: 'Shop // web', path: 'shop' }, { path: '../crm' }, { path: 'docs' }, { uri: 'vscode-remote://ssh-remote+box/srv/api' }],
        settings: { 'editor.tabSize': 2, url: 'http://x/*y*/' }
    });

    const fresh = join(dir, 'nested', 'new.code-workspace');
    writeCodeWorkspace(fresh, [{ path: dir }]);
    expect(readCodeWorkspace(fresh).folders).toEqual([{ path: dir }]);

    writeFileSync(file, '{ broken');
    expect(() => writeCodeWorkspace(file, [])).toThrow();
    expect(readFileSync(file, 'utf8')).toBe('{ broken');
});

test('a session restores workspaces, the shown repos, the active workspace and the recent order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'appling-desktop-'));
    const one = join(dir, 'one.code-workspace');
    const two = join(dir, 'two.code-workspace');
    writeCodeWorkspace(one, folders('/a', '/b'));
    writeCodeWorkspace(two, folders('/c'));
    const before = new Workspaces();
    before.open(one, readCodeWorkspace(one).folders);
    before.open(two, readCodeWorkspace(two).folders);
    before.select('/b');
    before.select('/c');
    before.pin(one, '/b', true);
    before.hide(one, '/a', true);
    before.collapsed = true;
    const file = join(dir, 'session.json');
    writeSession(file, sessionOf(before));
    // a workspace file changed outside the app, and one is gone
    writeCodeWorkspace(two, folders('/c', '/d'));
    const session = readSession(file)!;
    session.workspaces.push(join(dir, 'gone.code-workspace'));

    const after = new Workspaces();
    expect(restore(session, after)).toEqual([`${join(dir, 'gone.code-workspace')}: the workspace file is gone`]);
    expect(after.all().map(w => w.name)).toEqual(['one', 'two']);
    expect(after.active).toBe(two);
    expect(after.activeRepo()).toBe('/c');
    expect(after.get(one)?.active).toBe('/b');
    expect(after.mostRecent()).toEqual(['/c', '/b', '/a', '/d']);
    expect(after.get(one)).toMatchObject({ pinned: ['/b'], hidden: ['/a'] });
    expect(after.get(two)).toMatchObject({ pinned: [], hidden: [] });
    expect(after.collapsed).toBe(true);
    expect(readSession(join(dir, 'missing.json'))).toBeUndefined();
});

test('keybindings override the defaults, unbind with null and report mistakes', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'appling-desktop-')), 'keybindings.json');
    expect(loadKeybindings(file)).toEqual({ bindings: DEFAULT_KEYBINDINGS, problems: [] });
    writeFileSync(file, JSON.stringify({ open: 'CmdOrCtrl+Shift+O', quit: null, nextRepo: 'Ctrl+Nope', fly: 'F1' }));
    const { bindings, problems } = loadKeybindings(file);
    expect(bindings.open).toBe('CmdOrCtrl+Shift+O');
    expect(bindings.quit).toBeNull();
    expect(bindings.nextRepo).toBe(DEFAULT_KEYBINDINGS.nextRepo);
    expect(problems).toEqual(['invalid shortcut "Ctrl+Nope" for "nextRepo"', 'unknown command "fly"']);
    writeFileSync(file, '{ broken');
    expect(loadKeybindings(file).bindings).toEqual(DEFAULT_KEYBINDINGS);
    expect(loadKeybindings(file).problems).toHaveLength(1);
});

test('every default shortcut is valid and no two commands share one', () => {
    const accelerators = Object.values(DEFAULT_KEYBINDINGS).filter(Boolean);
    expect(new Set(accelerators).size).toBe(accelerators.length);
    const file = join(mkdtempSync(join(tmpdir(), 'appling-desktop-')), 'keybindings.json');
    writeFileSync(file, JSON.stringify(DEFAULT_KEYBINDINGS));
    expect(loadKeybindings(file).problems).toEqual([]);
});

let ide: IdeProcess | undefined;
afterEach(() => ide?.close());

test('each repo gets its own IDE server process that reports its URL and ends with its parent channel', async () => {
    const root = mkdtempSync(join(tmpdir(), 'appling-desktop-'));
    cpSync(join(import.meta.dirname, '../../../examples'), root, { recursive: true });
    ide = await startIdeProcess(root);
    expect(ide.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const snapshot = await (await fetch(`${ide.url}/api/snapshot`)).json();
    expect(snapshot.errors).toEqual([]);
    const exited = new Promise(done => ide!.child.once('exit', done));
    ide.close();
    ide = undefined;
    await exited;
}, 30000);

test('a server that cannot start rejects with its reason', async () => {
    await expect(startIdeProcess('/does/not/exist', { timeout: 15000 })).rejects.toThrow(/ended with code|did not start/);
}, 20000);

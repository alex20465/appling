import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { startIdeProcess, type IdeProcess } from '../src/ide-process.js';
import { DEFAULT_KEYBINDINGS, loadKeybindings } from '../src/keybindings.js';
import { Repos } from '../src/repos.js';

test('a folder opened twice stays one repo and becomes active', () => {
    const repos = new Repos();
    expect(repos.add('/work/shop').added).toBe(true);
    expect(repos.add('/work/crm').added).toBe(true);
    expect(repos.add('/work/shop/').added).toBe(false);
    expect(repos.all().map(r => r.name)).toEqual(['shop', 'crm']);
    expect(repos.active).toBe(resolve('/work/shop'));
});

test('closing the active repo activates its neighbour', () => {
    const repos = new Repos();
    ['/a', '/b', '/c'].forEach(f => repos.add(f));
    repos.select('/b');
    repos.close('/b');
    expect(repos.active).toBe('/c');
    repos.close('/c');
    expect(repos.active).toBe('/a');
    repos.close('/a');
    expect(repos.active).toBeUndefined();
});

test('repos cycle with wrap around and are reached by position', () => {
    const repos = new Repos();
    ['/a', '/b', '/c'].forEach(f => repos.add(f));
    repos.cycle(1);
    expect(repos.active).toBe('/a');
    repos.cycle(-1);
    expect(repos.active).toBe('/c');
    expect(repos.selectAt(1)).toBe(true);
    expect(repos.active).toBe('/b');
    expect(repos.selectAt(5)).toBe(false);
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

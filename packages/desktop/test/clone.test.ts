import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { expect, test } from 'vitest';
import { cloneFolderName, cloneRepo, defaultCloneParent, parseCloneProgress, type CloneProgress } from '../src/clone.js';

/** A repo with one commit to clone from. */
function source(): string {
    const repo = mkdtempSync(join(tmpdir(), 'appling-clone-src-'));
    const run = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    run('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'shop.appling'), 'module shop {\n}\n');
    run('add', '.');
    run('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'first');
    return repo;
}

test('the folder name follows from https, ssh, file URLs and paths', () => {
    expect(cloneFolderName('https://github.com/alex20465/appling.git')).toBe('appling');
    expect(cloneFolderName('https://github.com/alex20465/appling/')).toBe('appling');
    expect(cloneFolderName('git@github.com:alex20465/appling.git')).toBe('appling');
    expect(cloneFolderName('ssh://git@host:2222/team/shop')).toBe('shop');
    expect(cloneFolderName('file:///srv/git/crm.git/')).toBe('crm');
    expect(cloneFolderName('  ')).toBeUndefined();
});

test('progress lines of git clone are read', () => {
    expect(parseCloneProgress("Cloning into '/tmp/x'...")).toEqual({ phase: 'Cloning' });
    expect(parseCloneProgress('Receiving objects:  45% (45/100), 1.2 MiB | 2 MiB/s')).toEqual({ phase: 'Receiving objects', percent: 45 });
    expect(parseCloneProgress('remote: Counting objects: 100% (12/12), done.')).toEqual({ phase: 'Counting objects', percent: 100 });
    expect(parseCloneProgress('Resolving deltas: 100% (3/3), done.')).toEqual({ phase: 'Resolving deltas', percent: 100 });
    expect(parseCloneProgress('warning: You appear to have cloned an empty repository.')).toBeUndefined();
});

test('a repo is cloned into a new folder below the parent, with progress', async () => {
    const from = source();
    const parent = mkdtempSync(join(tmpdir(), 'appling-clone-'));
    const progress: CloneProgress[] = [];
    // file:// makes git use its transport (and report progress) instead of copying the folder
    const folder = await cloneRepo(`file://${from}`, parent, { onProgress: p => progress.push(p) });
    expect(folder).toBe(join(parent, basename(from)));
    expect(readdirSync(folder)).toContain('shop.appling');
    expect(progress[0]).toEqual({ phase: 'Cloning' });
    expect(progress.some(p => p.percent === 100)).toBe(true);
    // a second clone into the same, now non empty folder is refused before git runs
    await expect(cloneRepo(`file://${from}`, parent)).rejects.toThrow(/exists already/);
    expect(await cloneRepo(from, parent, { name: 'copy' })).toBe(join(parent, 'copy'));
}, 20000);

test('a failed clone rejects with the message of git and leaves no folder behind', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'appling-clone-'));
    await expect(cloneRepo(join(parent, 'missing'), parent, { name: 'x' })).rejects.toThrow(/fatal:/);
    expect(existsSync(join(parent, 'x'))).toBe(false);
    await expect(cloneRepo('', parent)).rejects.toThrow(/URL/);
    await expect(cloneRepo('https://example.com/a.git', join(parent, 'nope'))).rejects.toThrow(/does not exist/);
}, 20000);

test('a clone can be cancelled', async () => {
    const from = source();
    const parent = mkdtempSync(join(tmpdir(), 'appling-clone-'));
    const controller = new AbortController();
    const cloning = cloneRepo(`file://${from}`, parent, { name: 'x', signal: controller.signal });
    controller.abort();
    await expect(cloning).rejects.toThrow(/cancelled/);
    expect(existsSync(join(parent, 'x'))).toBe(false);
});

test('the clone is proposed next to the first repo of the workspace, else in ~/src or home', () => {
    const home = mkdtempSync(join(tmpdir(), 'appling-home-'));
    expect(defaultCloneParent(['/work/client/api', '/elsewhere/web'], home)).toBe('/work/client');
    expect(defaultCloneParent([], home)).toBe(home);
    mkdirSync(join(home, 'src'));
    expect(defaultCloneParent([], home)).toBe(join(home, 'src'));
});

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { startIdeProcess, type IdeStatus } from '../src/ide-process.js';
import { agentContributions, emptyCounts, RailStatus, railBadge, railLines } from '../src/rail-status.js';

test('each source owns its contributions; a repo sums them and a workspace sums its repos', () => {
    const rail = new RailStatus();
    let changes = 0;
    rail.onChange(() => changes++);
    const validation = rail.source('validation');
    const editor = rail.source('editor');
    const git = rail.source('git');
    validation.set('/a', { counts: { errors: 2 } });
    editor.set('/a', { counts: { unsaved: 1 }, notes: ['Unsaved: shop.appling'] });
    git.set('/a', { branch: 'main' });
    validation.set('/b/', { counts: { errors: 1 } });
    expect(rail.repo('/a')).toEqual({ counts: { ...emptyCounts(), errors: 2, unsaved: 1 }, branch: 'main', notes: ['Unsaved: shop.appling'] });
    expect(rail.repo('/b').counts.errors).toBe(1);
    expect(rail.sum(['/a', '/b', '/a', '/unknown'])).toEqual({ ...emptyCounts(), errors: 3, unsaved: 1 });
    expect(changes).toBe(4);
    validation.set('/a', { counts: { errors: 2 } });
    expect(changes).toBe(4);

    editor.clear('/a');
    expect(rail.repo('/a').counts.unsaved).toBe(0);
    expect(rail.repo('/a').counts.errors).toBe(2);
    rail.clear(undefined, '/a');
    expect(rail.repo('/a')).toEqual({ counts: emptyCounts(), notes: [] });
    expect(rail.repo('/b').counts.errors).toBe(1);
});

test('replace sets a source for every repo at once and drops the repos it leaves out', () => {
    const rail = new RailStatus();
    const agents = rail.source('agents');
    agents.replace({ '/a': { counts: { agentsWorking: 1 } }, '/b': { counts: { agentsWaiting: 1 } } });
    let changes = 0;
    rail.onChange(() => changes++);
    agents.replace(new Map([['/a', { counts: { agentsWorking: 1 } }], ['/b', { counts: { agentsWaiting: 1 } }]]));
    expect(changes).toBe(0);
    agents.replace({ '/b': { counts: { agentsWaiting: 2 } } });
    expect(changes).toBe(1);
    expect(rail.repo('/a').counts.agentsWorking).toBe(0);
    expect(rail.repo('/b').counts.agentsWaiting).toBe(2);
});

test('agent sessions count per repo as working, waiting for the user or failed; done ones not at all', () => {
    const counts = agentContributions([
        { repo: '/a', status: 'working' }, { repo: '/a', status: 'working' }, { repo: '/a', status: 'needs-input' },
        { repo: '/b', status: 'blocked' }, { repo: '/b', status: 'failed' }, { repo: '/c', status: 'done' }
    ]);
    expect(Object.fromEntries(counts)).toEqual({
        '/a': { counts: { agentsWorking: 2, agentsWaiting: 1 } },
        '/b': { counts: { agentsWaiting: 1, agentsFailed: 1 } }
    });
});

test('the badge shows the most urgent count and the tooltip lists everything', () => {
    const counts = { ...emptyCounts(), errors: 3, unsaved: 2, agentsWorking: 1 };
    expect(railBadge(counts)).toEqual({ kind: 'errors', count: 3 });
    expect(railBadge({ ...counts, agentsWaiting: 1 })).toEqual({ kind: 'agentsWaiting', count: 1 });
    expect(railBadge(emptyCounts())).toBeUndefined();
    expect(railLines({ counts, branch: 'main', notes: ['Unsaved: a.appling'] }))
        .toEqual(['On main', '3 validation errors', '1 agent working', '2 unsaved files', 'Unsaved: a.appling']);
    expect(railLines({ counts: emptyCounts(), branch: 'main', git: { upstream: 'origin/main', ahead: 2, behind: 1, dirty: 3 } }))
        .toEqual(['On main, 2 ahead and 1 behind origin/main, 3 changed files']);
    expect(railLines({ counts: emptyCounts(), branch: 'dev', git: { ahead: 0, behind: 4, dirty: 1 } }))
        .toEqual(['On dev, 4 behind its upstream, 1 changed file']);
});

test('a repo server passes on the unsaved files its view reports', async () => {
    const root = mkdtempSync(join(tmpdir(), 'appling-desktop-'));
    writeFileSync(join(root, 'shop.appling'), 'module shop {\n}\n');
    const unsaved: string[][] = [];
    let next: (() => void) | undefined;
    const ide = await startIdeProcess(root, { onStatus: (status: IdeStatus) => { if (status.unsaved) { unsaved.push(status.unsaved); next?.(); } } });
    try {
        const socket = new WebSocket(`${ide.url.replace('http', 'ws')}/events`);
        await new Promise(done => socket.addEventListener('open', done));
        const reported = new Promise<void>(done => next = done);
        socket.send(JSON.stringify({ type: 'unsaved', files: ['shop.appling'] }));
        await reported;
        expect(unsaved).toEqual([['shop.appling']]);
        const cleared = new Promise<void>(done => next = done);
        socket.close();
        await cleared;
        expect(unsaved.at(-1)).toEqual([]);
    } finally {
        ide.close();
    }
}, 30000);

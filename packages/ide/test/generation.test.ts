import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import type { GenerationEvent } from '@appling/codegen';
import { MemoryPlaybookStore } from '@appling/ai';
import { parseSelection } from '../src/server/generation.js';
import { playbookChapters } from '../src/server/generation-chapter.js';
import type { PlaybookHook } from '../src/server/generation-chapter.js';
import { startIde, type Ide, type Implementation } from '../src/server/server.js';
import type { GenerationRun, Snapshot } from '../src/shared/snapshot.js';

/** An extension package in the workspace: one class per entity in models.txt, a task per action. */
const EXTENSION = `export default {
    name: 'classes',
    steps(node) {
        if (node.kind === 'Entity') return [{ kind: 'template', file: 'models.txt', write: existing => (existing ?? '') + 'class ' + node.qn + ':\\n    pass\\n' }];
        if (node.kind === 'Action') return [{ kind: 'task', what: 'implement ' + node.qn }];
        return [];
    }
};
`;

let ide: Ide;
let root: string;
const chapters: { title: string, events: string[], closed?: unknown }[] = [];
const implementations: Implementation[] = [];

beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'appling-ide-generate-'));
    cpSync(join(import.meta.dirname, '../../../examples'), root, { recursive: true });
    mkdirSync(join(root, 'node_modules/classes'), { recursive: true });
    writeFileSync(join(root, 'node_modules/classes/package.json'), JSON.stringify({ name: 'classes', type: 'module', main: 'index.js' }));
    writeFileSync(join(root, 'node_modules/classes/index.js'), EXTENSION);
    writeFileSync(join(root, 'appling.config.json'), JSON.stringify({ generate: [{ extension: 'classes', out: 'out' }] }));
    const playbook: PlaybookHook = {
        onGenerationRun(run) {
            const chapter: (typeof chapters)[number] = { title: run.title, events: [] };
            chapters.push(chapter);
            return { add: event => chapter.events.push(event.type), close: result => chapter.closed = result };
        }
    };
    ide = await startIde(root, 0, { generationChapters: playbook, onImplementation: state => implementations.push(state) });
});

afterAll(() => ide.close());

test('selections are parsed strictly', () => {
    expect(parseSelection({ mode: 'outstanding' })).toEqual({ mode: 'outstanding' });
    expect(parseSelection({ mode: 'elements', elements: ['sales.Order'] })).toEqual({ mode: 'elements', elements: ['sales.Order'] });
    expect(parseSelection({ mode: 'elements', elements: [] })).toBeUndefined();
    expect(parseSelection({ mode: 'elements', elements: [3] })).toBeUndefined();
    expect(parseSelection(undefined)).toBeUndefined();
});

test('the IDE generates the outstanding elements in a worker, streams the run, writes a playbook chapter and marks what is implemented', async () => {
    const before: Snapshot = await (await fetch(`${ide.url}/api/snapshot`)).json();
    expect(before.targets).toEqual([{ extension: 'classes', out: 'out', generated: false }]);
    expect(before.implementation['sales.Order']).toMatchObject({ state: 'unimplemented', outstanding: true });

    const socket = new WebSocket(ide.url.replace('http', 'ws') + '/events', { origin: ide.url });
    await new Promise(resolve => socket.on('open', resolve));
    const events: GenerationEvent[] = [];
    const ended = new Promise<GenerationRun>(resolve => socket.on('message', data => {
        const message = JSON.parse(data.toString());
        if (message.type === 'generation-event') events.push(message.event);
        if (message.type === 'generation' && message.run.ended) resolve(message.run);
    }));
    const snapshotAfter = new Promise<Snapshot>(resolve => ended.then(() => socket.on('message', data => {
        const message = JSON.parse(data.toString());
        if (message.type === 'snapshot') resolve(message.snapshot);
    })));

    expect((await fetch(`${ide.url}/api/generate`, { method: 'POST', body: '{}' })).status).toBe(400);
    const started = await fetch(`${ide.url}/api/generate`, { method: 'POST', body: JSON.stringify({ selection: { mode: 'outstanding' } }) });
    expect(started.status).toBe(202);
    expect((await started.json()).title).toMatch(/^Generate \d+ outstanding elements$/);
    expect((await fetch(`${ide.url}/api/generate`, { method: 'POST', body: JSON.stringify({ selection: { mode: 'all' } }) })).status).toBe(409);

    const run = await ended;
    expect(run.events.at(-1)).toMatchObject({ type: 'done', failed: false });
    expect(events.map(e => e.type)).toEqual(expect.arrayContaining(['start', 'planned', 'generated', 'tasks', 'done']));
    expect(chapters).toHaveLength(1);
    expect(chapters[0].events).toEqual(expect.arrayContaining(['planned', 'generated', 'tasks']));
    expect(chapters[0].closed).toMatchObject({ failed: false });

    const after = await snapshotAfter;
    expect(after.implementation['sales.Order']).toMatchObject({ state: 'implemented', outstanding: false });
    expect(after.code['sales.Order']).toMatchObject([{ file: 'out/models.txt', status: 'current', text: 'class sales.Order:\n    pass' }]);
    expect(after.tasks.some(t => t.qn === 'sales.PlaceOrder' || t.kind === 'Action')).toBe(true);
    expect((await (await fetch(`${ide.url}/api/generation`)).json()).id).toBe(run.id);
    socket.close();

    const marks = implementations.at(-1)!;
    const sales = Object.entries(marks.marks).find(([path]) => path.endsWith('sales.appling'))![1];
    expect(sales.find(m => m.qn === 'sales.Order')).toMatchObject({ state: 'implemented' });
    expect(marks.links[join(root, 'out/models.txt')]).toContainEqual({ qn: 'sales.Order', start: expect.any(Number), end: expect.any(Number) });
});

test('code files are served read only from the workspace and the targets', async () => {
    writeFileSync(join(root, 'notes.py'), 'x = 1\n');
    expect(await (await fetch(`${ide.url}/api/code?path=notes.py`)).json()).toEqual({ path: 'notes.py', text: 'x = 1\n' });
    expect((await fetch(`${ide.url}/api/code?path=../outside.py`)).status).toBe(404);
    expect((await fetch(`${ide.url}/api/code?path=.git/config`)).status).toBe(404);
});

test('a generation run becomes a playbook chapter: the planned parts, done when generated, the tasks it left, the result', async () => {
    const store = new MemoryPlaybookStore();
    const hook = playbookChapters(store, async () => '/work', '/work/repo');
    const chapter = hook.onGenerationRun({ id: 'r', title: 'Generate 2 outstanding elements', selection: { mode: 'outstanding' }, started: '' });
    chapter.add({ type: 'planned', target: 'out', mode: 'sync', elements: ['sales', 'sales.Order', 'sales.Order.total', 'sales.PlaceOrder'], steps: ['sales.Order: template: models.py'] });
    chapter.add({ type: 'log', target: 'out', line: 'ignored' });
    chapter.add({ type: 'merged', target: 'out', report: { updated: ['models.py'], added: [], removed: [], merged: [], conflicts: [], kept: [] } });
    chapter.add({ type: 'generated', target: 'out', elements: [{ qn: 'sales.Order', files: ['models.py'] }, { qn: 'sales.PlaceOrder', files: [] }], references: 1 });
    chapter.add({ type: 'tasks', target: 'out', tasks: [{ qn: 'sales.PlaceOrder', missing: ['implement what PlaceOrder does'] }] });
    chapter.close({ failed: false, generated: 2, tasks: 1 });
    await expect.poll(async () => (await store.read('/work')).chapters[0]?.status).toBe('closed');
    const [written] = (await store.read('/work')).chapters;
    expect(written).toMatchObject({ title: 'Generate 2 outstanding elements', label: 'Code generation', repo: '/work/repo', result: '2 elements generated, 1 element with open registry tasks' });
    expect(written.steps).toMatchObject([
        { n: 1, state: 'done', change: 'change', elements: ['sales.Order', 'sales.PlaceOrder'], doneNote: '2 elements generated, 1 file, 1 code reference; files: 1 updated' },
        { n: 2, state: 'done', change: 'show', elements: ['sales.PlaceOrder'] }
    ]);
    expect(written.steps[1].note).toContain('sales.PlaceOrder: implement what PlaceOrder does');
});

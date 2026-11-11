import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import type { GenerationEvent } from '@appling/codegen';
import { parseSelection } from '../src/server/generation.js';
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
const implementations: Implementation[] = [];

beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'appling-ide-generate-'));
    cpSync(join(import.meta.dirname, '../../../examples'), root, { recursive: true });
    mkdirSync(join(root, 'node_modules/classes'), { recursive: true });
    writeFileSync(join(root, 'node_modules/classes/package.json'), JSON.stringify({ name: 'classes', type: 'module', main: 'index.js' }));
    writeFileSync(join(root, 'node_modules/classes/index.js'), EXTENSION);
    writeFileSync(join(root, 'appling.config.json'), JSON.stringify({ generate: [{ extension: 'classes', out: 'out' }] }));
    ide = await startIde(root, 0, { onImplementation: state => implementations.push(state) });
});

afterAll(() => ide.close());

test('selections are parsed strictly', () => {
    expect(parseSelection({ mode: 'outstanding' })).toEqual({ mode: 'outstanding' });
    expect(parseSelection({ mode: 'elements', elements: ['sales.Order'] })).toEqual({ mode: 'elements', elements: ['sales.Order'] });
    expect(parseSelection({ mode: 'elements', elements: [] })).toBeUndefined();
    expect(parseSelection({ mode: 'elements', elements: [3] })).toBeUndefined();
    expect(parseSelection(undefined)).toBeUndefined();
});

test('the IDE generates the outstanding elements in a worker, streams the run and marks what is implemented', async () => {
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

test('a stack chosen in the IDE becomes a target of appling.config.json', async () => {
    const fresh = mkdtempSync(join(tmpdir(), 'appling-ide-stack-'));
    cpSync(join(import.meta.dirname, '../../../examples'), fresh, { recursive: true });
    const other = await startIde(fresh, 0);
    try {
        expect((await fetch(`${other.url}/api/targets`, { method: 'POST', body: JSON.stringify({ stack: 'cobol' }) })).status).toBe(400);
        const targets = await (await fetch(`${other.url}/api/targets`, { method: 'POST', body: JSON.stringify({ stack: 'django' }) })).json();
        expect(targets).toEqual([{ extension: '@appling/codegen-django', out: expect.stringMatching(/^build\/appling_ide_stack_/) }]);
        const snapshot = await (await fetch(`${other.url}/api/snapshot`)).json() as Snapshot;
        expect(snapshot.targets).toEqual([expect.objectContaining({ extension: '@appling/codegen-django', generated: false })]);
        expect(readFileSync(join(fresh, '.gitignore'), 'utf8')).toMatch(/^build\/appling_ide_stack_\w+\/\.venv\/$/m);
    } finally {
        other.close();
    }
});

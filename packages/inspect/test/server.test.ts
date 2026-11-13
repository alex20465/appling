import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import { recordReferences } from '@appling/model';
import { startInspect, type Inspect } from '../src/server/server.js';
import { fileMarks } from '../src/server/workspace.js';
import type { Snapshot } from '../src/shared/snapshot.js';
import { elementAt } from '@appling/viz/views';

let inspect: Inspect;
let root: string;

beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'appling-inspect-'));
    cpSync(join(import.meta.dirname, '../../../examples'), root, { recursive: true });
    inspect = await startInspect(root);
});

afterAll(() => inspect.close());

test('the snapshot has files, graph and locations', async () => {
    const snapshot = await (await fetch(`${inspect.url}/api/snapshot`)).json();
    expect(snapshot.files.map((f: { path: string }) => f.path).sort()).toEqual(['crm.appling', 'sales.appling']);
    expect(snapshot.errors).toEqual([]);
    expect(snapshot.locations['sales.Order'].uri).toMatch(/sales\.appling$/);
    expect(snapshot.dependencies).toContainEqual({ from: 'sales', to: 'crm', count: 16 });
});

test('the snapshot has the code references with their lines', async () => {
    writeFileSync(join(root, 'models.py'), 'import x\n\nclass Order(models.Model):\n    pass\n');
    recordReferences(root, 'sales.Order', [{ file: 'models.py', start: 3, end: 4 }]);
    const snapshot = await (await fetch(`${inspect.url}/api/snapshot`)).json();
    expect(snapshot.code['sales.Order']).toMatchObject([{ file: 'models.py', start: 3, end: 4, status: 'current', text: 'class Order(models.Model):\n    pass' }]);
});

test('a declaring line that is no element carries its code reference, state and mark by its sub-anchor (#20)', async () => {
    writeFileSync(join(root, 'checkout.py'), 'def checkout(order):\n    charge(order.total)\n');
    recordReferences(root, 'sales.Checkout#step[2]', [{ file: 'checkout.py', start: 2, end: 2 }]);
    const snapshot = await (await fetch(`${inspect.url}/api/snapshot`)).json() as Snapshot;
    const address = 'sales.Checkout#step[2]';
    const file = snapshot.files.find(f => f.path === 'sales.appling')!;
    const location = snapshot.locations[address];
    expect(file.text.slice(location.start, location.end)).toBe('step Payments.Charge(order.total) on Declined do Cancel(order)');
    expect(snapshot.code[address]).toMatchObject([{ file: 'checkout.py', start: 2, status: 'current', text: '    charge(order.total)' }]);
    expect(snapshot.anchors[address]).toMatchObject({ state: 'implemented', references: 1 });
    // the other steps show their use case's state; the elements' states hold no sub-anchors
    expect(snapshot.anchors['sales.Checkout#step[1]'].state).toBe(snapshot.implementation['sales.Checkout'].state);
    expect(snapshot.implementation[address]).toBeUndefined();
    // the gutter of Desktop's code view marks the step's own line
    const line = file.text.slice(0, location.start).split('\n').length;
    const marks = Object.entries(fileMarks(snapshot)).find(([path]) => path.endsWith('sales.appling'))![1];
    // (its handler is on the same line and shows the step's state)
    expect(marks.find(m => m.line === line)).toMatchObject({ qn: `${address}.on[Declined]`, state: 'implemented' });
    // the cursor on the handler selects the handler's own address
    const handler = snapshot.locations[`${address}.on[Declined]`];
    expect(elementAt(snapshot.locations, file.uri, handler.start + 3)).toBe(`${address}.on[Declined]`);
    recordReferences(root, address, []);
});

test('requests from other origins are refused', async () => {
    expect((await fetch(`${inspect.url}/api/snapshot`, { headers: { origin: 'https://evil.example' } })).status).toBe(403);
});

test('a trusted origin is accepted from then on, and only VS Code webviews may embed the client', async () => {
    const forwarded = { origin: 'http://localhost:49999' };
    expect((await fetch(`${inspect.url}/api/release`, { headers: forwarded })).status).toBe(403);
    inspect.trust(forwarded.origin);
    inspect.trust('javascript:alert(1)');
    expect((await fetch(`${inspect.url}/api/release`, { headers: forwarded })).status).toBe(200);
    const page = await fetch(`${inspect.url}/`);
    expect(page.headers.get('content-security-policy')).toBe("frame-ancestors 'self' vscode-webview: vscode-file: https://*.vscode-cdn.net");
});

test('view settings are stored outside the model', async () => {
    expect(await (await fetch(`${inspect.url}/api/view`)).json()).toEqual({});
    const view = { linkEntities: true, direction: 'DOWN' };
    expect((await fetch(`${inspect.url}/api/view`, { method: 'PUT', body: JSON.stringify(view) })).status).toBe(204);
    expect(await (await fetch(`${inspect.url}/api/view`)).json()).toEqual(view);
    expect(JSON.parse(readFileSync(join(root, '.appling/view.json'), 'utf8'))).toEqual(view);
});

test('changes on disk are pushed as snapshots', async () => {
    const socket = new WebSocket(inspect.url.replace('http', 'ws') + '/events', { origin: inspect.url });
    await new Promise(resolve => socket.on('open', resolve));
    const pushed = new Promise<{ snapshot: { graph: { nodes: { qn: string }[] } } }>(resolve => socket.on('message', data => {
        const message = JSON.parse(data.toString());
        if (message.type === 'snapshot') resolve(message);
    }));
    writeFileSync(join(root, 'extra.appling'), 'module extra {\n}\n');
    const message = await pushed;
    expect(message.snapshot.graph.nodes.map(n => n.qn)).toContain('extra');
    socket.close();
});

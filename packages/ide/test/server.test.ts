import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import { recordReferences, writeRelease } from '@appling/model';
import { startIde, type Ide } from '../src/server/server.js';

let ide: Ide;
let root: string;

beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'appling-ide-'));
    cpSync(join(import.meta.dirname, '../../../examples'), root, { recursive: true });
    ide = await startIde(root);
});

afterAll(() => ide.close());

test('the snapshot has files, graph and locations', async () => {
    const snapshot = await (await fetch(`${ide.url}/api/snapshot`)).json();
    expect(snapshot.files.map((f: { path: string }) => f.path).sort()).toEqual(['crm.appling', 'sales.appling']);
    expect(snapshot.errors).toEqual([]);
    expect(snapshot.locations['sales.Order'].uri).toMatch(/sales\.appling$/);
    expect(snapshot.dependencies).toContainEqual({ from: 'sales', to: 'crm', count: 7 });
});

test('the snapshot has the code references with their lines', async () => {
    writeFileSync(join(root, 'models.py'), 'import x\n\nclass Order(models.Model):\n    pass\n');
    recordReferences(root, 'sales.Order', [{ file: 'models.py', start: 3, end: 4 }]);
    const snapshot = await (await fetch(`${ide.url}/api/snapshot`)).json();
    expect(snapshot.code['sales.Order']).toMatchObject([{ file: 'models.py', start: 3, end: 4, status: 'current', text: 'class Order(models.Model):\n    pass' }]);
});

test('files are written only inside the workspace', async () => {
    expect((await fetch(`${ide.url}/api/file?path=../evil.appling`, { method: 'PUT', body: 'x' })).status).toBe(400);
    expect((await fetch(`${ide.url}/api/file?path=notes.txt`, { method: 'PUT', body: 'x' })).status).toBe(400);
    const text = readFileSync(join(root, 'crm.appling'), 'utf8');
    expect((await fetch(`${ide.url}/api/file?path=crm.appling`, { method: 'PUT', body: text })).status).toBe(204);
});

test('requests from other origins are refused', async () => {
    expect((await fetch(`${ide.url}/api/snapshot`, { headers: { origin: 'https://evil.example' } })).status).toBe(403);
});

test('view settings are stored outside the model', async () => {
    expect(await (await fetch(`${ide.url}/api/view`)).json()).toEqual({});
    const view = { linkEntities: true, direction: 'DOWN' };
    expect((await fetch(`${ide.url}/api/view`, { method: 'PUT', body: JSON.stringify(view) })).status).toBe(204);
    expect(await (await fetch(`${ide.url}/api/view`)).json()).toEqual(view);
    expect(JSON.parse(readFileSync(join(root, '.appling/view.json'), 'utf8'))).toEqual(view);
});

test('changes on disk are pushed as snapshots', async () => {
    const socket = new WebSocket(ide.url.replace('http', 'ws') + '/events', { origin: ide.url });
    await new Promise(resolve => socket.on('open', resolve));
    const pushed = new Promise<{ snapshot: { graph: { nodes: { qn: string }[] } } }>(resolve => socket.on('message', data => resolve(JSON.parse(data.toString()))));
    writeFileSync(join(root, 'extra.appling'), 'module extra {\n}\n');
    const message = await pushed;
    expect(message.snapshot.graph.nodes.map(n => n.qn)).toContain('extra');
    socket.close();
});

test('the language server answers over the websocket', async () => {
    const socket = new WebSocket(ide.url.replace('http', 'ws') + '/lsp', { origin: ide.url });
    await new Promise(resolve => socket.on('open', resolve));
    const reply = new Promise<{ result: { capabilities: { hoverProvider: boolean } } }>(resolve => socket.on('message', data => resolve(JSON.parse(data.toString()))));
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { processId: null, rootUri: null, capabilities: {} } }));
    expect((await reply).result.capabilities.hoverProvider).toBe(true);
    socket.close();
});

test('edits are applied to the sent texts and recorded as migration steps after a release', async () => {
    const snapshot = await (await fetch(`${ide.url}/api/snapshot`)).json();
    const sources = Object.fromEntries(snapshot.files.map((f: { uri: string, text: string }) => [f.uri, f.text]));
    expect(await (await fetch(`${ide.url}/api/release`)).json()).toBe(null);
    writeRelease(root, '1.0.0', snapshot.graph);
    expect((await (await fetch(`${ide.url}/api/release`)).json()).version).toBe('1.0.0');
    const result = await (await fetch(`${ide.url}/api/edit`, { method: 'POST', body: JSON.stringify({ sources, operation: { op: 'rename', target: 'crm.Account.email', name: 'mail' } }) })).json();
    expect(result.ok).toBe(true);
    const crm = Object.keys(result.sources).find(uri => uri.endsWith('crm.appling'))!;
    expect(result.sources[crm]).toContain('migration since_v1_0_0 {\n    rename Account.email -> mail\n  }');
    const rejected = await (await fetch(`${ide.url}/api/edit`, { method: 'POST', body: JSON.stringify({ sources, operation: { op: 'remove', target: 'crm.Account' } }) })).json();
    expect(rejected.ok).toBe(false);
});

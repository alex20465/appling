import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { WebSocket } from 'ws';
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

test('files are written only inside the workspace', async () => {
    expect((await fetch(`${ide.url}/api/file?path=../evil.appling`, { method: 'PUT', body: 'x' })).status).toBe(400);
    expect((await fetch(`${ide.url}/api/file?path=notes.txt`, { method: 'PUT', body: 'x' })).status).toBe(400);
    const text = readFileSync(join(root, 'crm.appling'), 'utf8');
    expect((await fetch(`${ide.url}/api/file?path=crm.appling`, { method: 'PUT', body: text })).status).toBe(204);
});

test('requests from other origins are refused', async () => {
    expect((await fetch(`${ide.url}/api/snapshot`, { headers: { origin: 'https://evil.example' } })).status).toBe(403);
});

test('layout is stored outside the model', async () => {
    const layout = { positions: { medium: { 'sales.Order': { x: 10, y: 20 } } } };
    await fetch(`${ide.url}/api/layout`, { method: 'PUT', body: JSON.stringify(layout) });
    expect(await (await fetch(`${ide.url}/api/layout`)).json()).toEqual(layout);
    expect(JSON.parse(readFileSync(join(root, '.appling/layout.json'), 'utf8'))).toEqual(layout);
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

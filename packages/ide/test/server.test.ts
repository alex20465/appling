import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import { recordReferences, writeRelease } from '@appling/model';
import { startIde, type Ide } from '../src/server/server.js';
import { fileMarks } from '../src/server/workspace.js';
import type { Snapshot } from '../src/shared/snapshot.js';
import { elementAt } from '@appling/viz/views';

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
    expect(snapshot.dependencies).toContainEqual({ from: 'sales', to: 'crm', count: 8 });
});

test('the snapshot has the code references with their lines', async () => {
    writeFileSync(join(root, 'models.py'), 'import x\n\nclass Order(models.Model):\n    pass\n');
    recordReferences(root, 'sales.Order', [{ file: 'models.py', start: 3, end: 4 }]);
    const snapshot = await (await fetch(`${ide.url}/api/snapshot`)).json();
    expect(snapshot.code['sales.Order']).toMatchObject([{ file: 'models.py', start: 3, end: 4, status: 'current', text: 'class Order(models.Model):\n    pass' }]);
});

test('a declaring line that is no element carries its code reference, state and mark by its sub-anchor (#20)', async () => {
    writeFileSync(join(root, 'checkout.py'), 'def checkout(order):\n    charge(order.total)\n');
    recordReferences(root, 'sales.Checkout#step[2]', [{ file: 'checkout.py', start: 2, end: 2 }]);
    const snapshot = await (await fetch(`${ide.url}/api/snapshot`)).json() as Snapshot;
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

test('files are written only inside the workspace', async () => {
    expect((await fetch(`${ide.url}/api/file?path=../evil.appling`, { method: 'PUT', body: 'x' })).status).toBe(400);
    expect((await fetch(`${ide.url}/api/file?path=notes.txt`, { method: 'PUT', body: 'x' })).status).toBe(400);
    const text = readFileSync(join(root, 'crm.appling'), 'utf8');
    expect((await fetch(`${ide.url}/api/file?path=crm.appling`, { method: 'PUT', body: text })).status).toBe(204);
});

test('requests from other origins are refused', async () => {
    expect((await fetch(`${ide.url}/api/snapshot`, { headers: { origin: 'https://evil.example' } })).status).toBe(403);
});

test('a trusted origin is accepted from then on, and only VS Code webviews may embed the client', async () => {
    const forwarded = { origin: 'http://localhost:49999' };
    expect((await fetch(`${ide.url}/api/release`, { headers: forwarded })).status).toBe(403);
    ide.trust(forwarded.origin);
    ide.trust('javascript:alert(1)');
    expect((await fetch(`${ide.url}/api/release`, { headers: forwarded })).status).toBe(200);
    const page = await fetch(`${ide.url}/`);
    expect(page.headers.get('content-security-policy')).toBe("frame-ancestors 'self' vscode-webview: vscode-file: https://*.vscode-cdn.net");
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
    const pushed = new Promise<{ snapshot: { graph: { nodes: { qn: string }[] } } }>(resolve => socket.on('message', data => {
        const message = JSON.parse(data.toString());
        if (message.type === 'snapshot') resolve(message);
    }));
    writeFileSync(join(root, 'extra.appling'), 'module extra {\n}\n');
    const message = await pushed;
    expect(message.snapshot.graph.nodes.map(n => n.qn)).toContain('extra');
    socket.close();
});

test('the unsaved files of every connected client are reported as one set, also when a client leaves', async () => {
    const own = mkdtempSync(join(tmpdir(), 'appling-ide-'));
    const reports: string[][] = [];
    let next: (() => void) | undefined;
    const reported = () => new Promise<void>(done => next = done);
    const server = await startIde(own, 0, { onUnsaved: files => { reports.push(files); next?.(); } });
    const connect = async () => {
        const socket = new WebSocket(server.url.replace('http', 'ws') + '/events', { origin: server.url });
        await new Promise(resolve => socket.on('open', resolve));
        return socket;
    };
    try {
        const [one, two] = [await connect(), await connect()];
        let wait = reported();
        one.send(JSON.stringify({ type: 'unsaved', files: ['b.appling', 'a.appling'] }));
        await wait;
        wait = reported();
        two.send(JSON.stringify({ type: 'unsaved', files: ['a.appling', 'c.appling'] }));
        await wait;
        expect(reports.at(-1)).toEqual(['a.appling', 'b.appling', 'c.appling']);
        wait = reported();
        one.close();
        await wait;
        expect(reports.at(-1)).toEqual(['a.appling', 'c.appling']);
        wait = reported();
        two.send(JSON.stringify({ type: 'unsaved', files: [] }));
        await wait;
        expect(reports).toHaveLength(4);
        expect(reports.at(-1)).toEqual([]);
        two.close();
    } finally {
        await server.close();
    }
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

test('a workspace reached through a symlink keeps one document per file', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'appling-ide-link-'));
    const real = join(folder, 'real');
    mkdirSync(real);
    const files = {
        'accounts.appling': 'module accounts {\n  export Account, Operator\n\n  entity Account {\n    name: String\n  }\n\n  entity Operator {\n    name: String\n  }\n\n  tenant AccountTenant on Account\n}\n',
        'keys.appling': 'module keys {\n  role Admin\n\n  actor human Staff roles Admin {\n    operator: accounts.Operator?\n  }\n\n  entity Key {\n    account: accounts.Account\n    operator: accounts.Operator\n    policy { actor.is(Admin) && account == tenant && operator == actor.operator }\n  }\n}\n'
    };
    Object.entries(files).forEach(([name, text]) => writeFileSync(join(real, name), text));
    symlinkSync(real, join(folder, 'link'));
    const linked = await startIde(join(folder, 'link'));
    const socket = new WebSocket(linked.url.replace('http', 'ws') + '/lsp', { origin: linked.url });
    await new Promise(resolve => socket.on('open', resolve));
    const uri = (name: string) => pathToFileURL(join(real, name)).toString();
    const diagnostics = new Promise<{ message: string }[]>(resolve => socket.on('message', data => {
        const message = JSON.parse(data.toString());
        if (message.method === 'textDocument/publishDiagnostics' && message.params.uri === uri('keys.appling')) resolve(message.params.diagnostics);
    }));
    const send = (message: object) => socket.send(JSON.stringify({ jsonrpc: '2.0', ...message }));
    send({ id: 1, method: 'initialize', params: { processId: null, rootUri: null, capabilities: {} } });
    send({ method: 'initialized', params: {} });
    for (const [name, text] of Object.entries(files)) {
        send({ method: 'textDocument/didOpen', params: { textDocument: { uri: uri(name), languageId: 'appling', version: 1, text } } });
    }
    expect((await diagnostics).map(d => d.message)).toEqual([]);
    socket.close();
    await linked.close();
});

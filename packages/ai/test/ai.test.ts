import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, test } from 'vitest';
import { writeRegistry } from '@appling/codegen';
import type { Bubble, Show, Status } from '@appling/viz';
import { createMcpServer, MAX_ATTEMPTS, Project, type VisualHost } from '../src/index.js';

function workspace(): string {
    const root = mkdtempSync(join(tmpdir(), 'appling-ai-'));
    cpSync(join(import.meta.dirname, '../../../examples'), root, { recursive: true });
    return root;
}

test('the MCP server exposes model and registry tools and the registry prompt', async () => {
    const root = workspace();
    const client = new Client({ name: 'test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([createMcpServer(root).connect(serverTransport), client.connect(clientTransport)]);
    expect((await client.listTools()).tools.map(t => t.name).sort()).toEqual(['check', 'code_references', 'edit', 'graph_query', 'implementation_status', 'language_reference', 'read_source', 'record_code_references', 'registry_next', 'registry_update', 'run_tests', 'simulate', 'write_model_file']);
    const text = async (name: string, args: Record<string, unknown>) => JSON.parse(((await client.callTool({ name, arguments: args })).content as { text: string }[])[0].text);
    expect((await text('language_reference', {})).pages).toContainEqual({ page: 'overview', title: 'Language overview', description: expect.any(String) });
    expect((await text('language_reference', { page: 'domain' })).markdown).toContain('entity');
    expect((await text('language_reference', { page: 'nope' })).error).toContain('No page nope');
    expect(await text('check', {})).toEqual({ errors: [] });
    expect((await text('graph_query', { qn: 'sales.Order' })).contains).toContain('sales.Order.status');
    expect((await text('read_source', { qn: 'crm.Clerk' })).source).toBe('crm.appling:\nrole Clerk');
    expect(await text('edit', { operation: { op: 'rename', target: 'crm.Account.email', name: 'mail' } })).toEqual({ ok: true, changed: ['crm.appling'] });
    expect(readFileSync(join(root, 'crm.appling'), 'utf8')).toContain('mail: String');
    writeFileSync(join(root, 'models.py'), 'class Order(models.Model):\n    pass\n');
    expect(await text('record_code_references', { qn: 'sales.Order', ranges: [{ file: 'models.py', start: 1, end: 2 }] })).toEqual([{ file: 'models.py', start: 1, end: 2, anchor: 'class Order(models.Model):' }]);
    expect((await text('record_code_references', { qn: 'sales.Nope', ranges: [] })).error).toBe('No element or sub-anchor sales.Nope.');
    expect((await text('code_references', { qn: 'sales.Order' })).references).toEqual([{ qn: 'sales.Order', file: 'models.py', start: 1, end: 2, anchor: 'class Order(models.Model):', status: 'current' }]);
    expect(await text('code_references', {})).toEqual({ references: [] });
    // a use case step is no element, but its line carries code references by its sub-anchor address (#20)
    expect(await text('record_code_references', { qn: 'sales.Checkout#step[2]', ranges: [{ file: 'models.py', start: 2, end: 2 }] })).toEqual([{ file: 'models.py', start: 2, end: 2, anchor: 'pass' }]);
    expect((await text('code_references', { qn: 'sales.Checkout' })).references).toMatchObject([{ qn: 'sales.Checkout#step[2]', status: 'current' }]);
    expect((await text('record_code_references', { qn: 'sales.Checkout#step[9]', ranges: [] })).error).toBe('No element or sub-anchor sales.Checkout#step[9].');
    await text('record_code_references', { qn: 'sales.Checkout#step[2]', ranges: [] });
    const prompt = await client.getPrompt({ name: 'implement_next_task' });
    expect((prompt.messages[0].content as { text: string }).text).toContain('registry_next');
});

test('registry tasks come in order, record attempts and stop after the limit', async () => {
    const root = workspace();
    writeFileSync(join(root, 'appling.config.json'), JSON.stringify({ generate: [{ extension: 'x', out: 'build/app' }] }));
    const entry = (qn: string, status: 'generated' | 'partial' | 'todo') => ({ qn, kind: 'Entity', layer: 'domain', status, steps: [], files: [], missing: status === 'generated' ? [] : [{ what: `finish ${qn}`, context: { props: {}, related: [] } }] });
    writeRegistry(join(root, 'build/app'), { extension: 'x', test: ['node', '-e', 'process.exit(0)'], entries: { a: entry('a', 'generated'), b: entry('b', 'partial'), c: entry('c', 'todo') } });
    const project = new Project(root);
    expect(project.nextTask()?.entry.qn).toBe('b');
    expect(project.updateTask('b', 'done')?.missing).toEqual([]);
    expect(project.nextTask()?.entry.qn).toBe('c');
    for (let i = 0; i < MAX_ATTEMPTS; i++) project.updateTask('c', 'partial', `try ${i}`);
    expect(project.nextTask()).toBeUndefined();
    expect(project.targets()[0].registry.entries.c.notes).toEqual(['try 0', 'try 1', 'try 2', 'stopped after 3 attempts']);
    expect(project.runTests()?.passed).toBe(true);
});

test('the simulate tool answers behavior questions and reports unknown elements as errors', async () => {
    const root = workspace();
    const client = new Client({ name: 'test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([createMcpServer(root).connect(serverTransport), client.connect(clientTransport)]);
    const ask = async (args: Record<string, unknown>) => JSON.parse(((await client.callTool({ name: 'simulate', arguments: args })).content as { text: string }[])[0].text);
    expect((await ask({ question: 'reach', machine: 'sales.OrderFlow', state: 'cancelled' })).path.map((p: { trigger: string }) => p.trigger)).toEqual(['Cancel']);
    expect(await ask({ question: 'actors', action: 'sales.Cancel' })).toEqual([{ actor: 'crm.Employee', verdict: 'yes' }, { actor: 'sales.Shopper', verdict: 'no' }]);
    expect(await ask({ question: 'run', action: 'sales.Cancel', record: { status: 'draft' }, actor: 'sales.Shopper' })).toMatchObject({ allowed: 'no', outcome: 'refused' });
    expect(await ask({ question: 'risks', action: 'sales.Nope' })).toEqual({ error: 'No element sales.Nope.' });
});

test('write_model_file writes only files that keep the workspace valid, inside the workspace', async () => {
    const root = workspace();
    const client = new Client({ name: 'test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([createMcpServer(root).connect(serverTransport), client.connect(clientTransport)]);
    const write = async (path: string, source: string) => JSON.parse(((await client.callTool({ name: 'write_model_file', arguments: { path, source } })).content as { text: string }[])[0].text);
    expect(await write('billing/billing.appling', 'module billing {\n  entity Invoice {\n    number: String unique\n  }\n}\n')).toEqual({ ok: true, written: 'billing/billing.appling' });
    expect(readFileSync(join(root, 'billing/billing.appling'), 'utf8')).toContain('entity Invoice');
    expect((await write('broken.appling', 'module broken {\n  entity A {\n    b: Missing\n  }\n}\n')).ok).toBe(false);
    expect(await write('../outside.appling', 'module x {\n}\n')).toEqual({ ok: false, errors: ['The path must be a .appling file inside the workspace.'] });
    const prompt = await client.getPrompt({ name: 'derive_model' });
    expect((prompt.messages[0].content as { text: string }).text).toContain('write_model_file');
});

function fakeCanvas() {
    const shown: Show[] = [];
    const bubbles: Bubble[] = [];
    const steps: Status[] = [];
    const host: VisualHost = {
        show: async show => { shown.push(show); },
        bubble: bubble => { bubbles.push(bubble); return true; },
        selection: () => ({ open: true, qn: 'sales.OrderStatus.placed', view: shown.at(-1) }),
        reply: () => true,
        status: async status => { steps.push(status); }
    };
    return { host, shown, bubbles, steps };
}

async function visualClient(root: string, host: VisualHost) {
    const client = new Client({ name: 'test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([createMcpServer(root, { visualizer: host }).connect(serverTransport), client.connect(clientTransport)]);
    const text = async (name: string, args: Record<string, unknown>) => JSON.parse(((await client.callTool({ name, arguments: args })).content as { text: string }[])[0].text);
    return { client, text };
}

test('with a visualizer the MCP server shows views and bubbles on the canvas', async () => {
    const window = fakeCanvas();
    const { client, text } = await visualClient(workspace(), window.host);
    expect(client.getServerCapabilities()?.experimental).toBeUndefined();
    expect(client.getInstructions()).toContain('The model is the source of truth for business logic.');
    expect(client.getInstructions()).toContain('visual_bubble');
    expect((await client.listTools()).tools.map(t => t.name)).toEqual(expect.arrayContaining(['visualize', 'visual_selection', 'visual_reply']));
    expect((await text('visualize', { view: 'machine', focus: ['sales.Order', 'sales.Nope'] })).error).toBe('The machine view draws Machine elements; not: sales.Order (Entity), sales.Nope (no such element).');
    expect(await text('visualize', { view: 'machine', focus: ['sales.OrderFlow'], title: 'Order lifecycle' })).toEqual({ shown: true });
    expect(window.shown).toEqual([{ view: 'machine', focus: ['sales.OrderFlow'], title: 'Order lifecycle' }]);
    expect(await text('visualize', { view: 'node', focus: ['sales.Order', 'crm'] })).toEqual({ shown: true });
    expect(await text('visual_bubble', { target: 'sales.Order.status', text: 'Moves through OrderFlow' })).toEqual({ placed: true });
    expect(await text('visual_bubble', { target: 'sales.Order', text: 'Stored here', code: 'class Order:', file: 'sales.appling', line: 3 })).toEqual({ placed: true });
    expect(window.bubbles.map(b => b.target)).toEqual(['sales.Order.status', 'sales.Order']);
    expect(await text('visual_bubble', { target: 'sales.Nope', text: 'x' })).toEqual({ placed: false, reason: 'No element sales.Nope.' });
    expect(await text('visual_bubble', { target: 'sales.Order', text: 'x', file: 'missing.py', line: 1 })).toEqual({ placed: false, reason: 'No file missing.py relative to the model folder.' });
    expect(await text('visual_selection', {})).toMatchObject({ open: true, qn: 'sales.OrderStatus.placed' });
    expect(await text('visual_status', { text: 'Implementing registry tasks', done: 2, total: 5 })).toEqual({ shown: true });
    expect(window.steps).toEqual([{ text: 'Implementing registry tasks', done: 2, total: 5 }]);
});

test('the MCP server without a visualizer has no visual tools', async () => {
    const client = new Client({ name: 'test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([createMcpServer(workspace()).connect(serverTransport), client.connect(clientTransport)]);
    expect(client.getServerCapabilities()?.experimental).toBeUndefined();
    expect(client.getInstructions()).toContain('The model is the source of truth for business logic.');
    expect(client.getInstructions()).not.toContain('visual_bubble');
    expect((await client.listTools()).tools.map(t => t.name)).not.toContain('visualize');
});

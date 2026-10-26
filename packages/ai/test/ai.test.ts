import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { expect, test } from 'vitest';
import { writeRegistry } from '@appling/codegen';
import type { Ask, Decision, Review, Show } from '@appling/viz';
import { chat, createMcpServer, MAX_ATTEMPTS, Project, type ChatEvent, type VisualHost } from '../src/index.js';

function workspace(): string {
    const root = mkdtempSync(join(tmpdir(), 'appling-ai-'));
    cpSync(join(import.meta.dirname, '../../../examples'), root, { recursive: true });
    return root;
}

const finish = (unified: 'stop' | 'tool-calls') => ({ type: 'finish' as const, finishReason: { unified, raw: undefined }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } });

test('a chat turn collects validated edits as a proposal without writing files', async () => {
    const root = workspace();
    const before = readFileSync(join(root, 'crm.appling'), 'utf8');
    const model = new MockLanguageModelV4({
        doStream: [
            { stream: convertArrayToReadableStream([{ type: 'tool-call', toolCallId: '1', toolName: 'edit', input: JSON.stringify({ operation: { op: 'add', parent: 'crm.Account', source: 'phone: String?' } }) }, finish('tool-calls')]) },
            { stream: convertArrayToReadableStream([{ type: 'tool-call', toolCallId: '2', toolName: 'edit', input: JSON.stringify({ operation: { op: 'remove', target: 'crm.Account' } }) }, finish('tool-calls')]) },
            { stream: convertArrayToReadableStream([{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'Added a phone number.' }, { type: 'text-end', id: 't' }, finish('stop')]) }
        ]
    });
    const events: ChatEvent[] = [];
    for await (const event of chat(root, [{ role: 'user', content: 'Add a phone number to accounts' }], model)) events.push(event);
    expect(events.filter(e => e.type === 'tool').map(e => e.type === 'tool' && e.name)).toEqual(['edit', 'edit']);
    expect(events.filter(e => e.type === 'text').map(e => e.type === 'text' && e.text).join('')).toBe('Added a phone number.');
    const proposal = events.find(e => e.type === 'proposal');
    expect(proposal?.type === 'proposal' && proposal.proposal).toMatchObject({
        operations: [{ op: 'add', parent: 'crm.Account', source: 'phone: String?' }],
        hunks: [{ file: 'crm.appling', removed: [], added: ['    phone: String?'] }],
        graph: { added: ['crm.Account.phone'], removed: [] }
    });
    expect(readFileSync(join(root, 'crm.appling'), 'utf8')).toBe(before);
});

test('the MCP server exposes model and registry tools and the registry prompt', async () => {
    const root = workspace();
    const client = new Client({ name: 'test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([createMcpServer(root).connect(serverTransport), client.connect(clientTransport)]);
    expect((await client.listTools()).tools.map(t => t.name).sort()).toEqual(['check', 'code_references', 'edit', 'graph_query', 'language_reference', 'read_source', 'record_code_references', 'registry_next', 'registry_update', 'run_tests', 'simulate', 'write_model_file']);
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
    expect((await text('record_code_references', { qn: 'sales.Nope', ranges: [] })).error).toBe('No element sales.Nope.');
    expect((await text('code_references', { qn: 'sales.Order' })).references).toEqual([{ qn: 'sales.Order', file: 'models.py', start: 1, end: 2, anchor: 'class Order(models.Model):', status: 'current' }]);
    expect(await text('code_references', {})).toEqual({ references: [] });
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
    expect(await ask({ question: 'actors', action: 'sales.Cancel' })).toEqual([{ actor: 'sales.Shopper', verdict: 'no' }]);
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

function fakeWindow(decision: Decision) {
    const shown: Show[] = [];
    const reviews: Review[] = [];
    const listeners: ((ask: Ask) => void)[] = [];
    const host: VisualHost = {
        show: async show => { shown.push(show); },
        selection: () => ({ open: true, qn: 'sales.OrderStatus.placed', view: shown.at(-1) }),
        reply: () => true,
        review: async review => { reviews.push(review); return decision; },
        onAsk: listener => { listeners.push(listener); }
    };
    return { host, shown, reviews, ask: (ask: Ask) => listeners.forEach(l => l(ask)) };
}

async function visualClient(root: string, host: VisualHost) {
    const client = new Client({ name: 'test', version: '1' });
    const notifications: unknown[] = [];
    client.fallbackNotificationHandler = async notification => { notifications.push(notification); };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([createMcpServer(root, { visualizer: host }).connect(serverTransport), client.connect(clientTransport)]);
    const text = async (name: string, args: Record<string, unknown>) => JSON.parse(((await client.callTool({ name, arguments: args })).content as { text: string }[])[0].text);
    return { client, notifications, text };
}

test('with a visualizer the MCP server is a channel that shows views and forwards questions from the window', async () => {
    const window = fakeWindow({ accepted: true });
    const { client, notifications, text } = await visualClient(workspace(), window.host);
    expect(client.getServerCapabilities()?.experimental).toEqual({ 'claude/channel': {} });
    expect(client.getInstructions()).toContain('The model is the source of truth for business logic.');
    expect(client.getInstructions()).toContain('visual_reply');
    expect((await client.listTools()).tools.map(t => t.name)).toEqual(expect.arrayContaining(['visualize', 'visual_selection', 'visual_reply', 'propose_edits']));
    expect((await text('visualize', { view: 'machine', focus: ['sales.Order', 'sales.Nope'] })).error).toBe('The machine view draws Machine elements; not: sales.Order (Entity), sales.Nope (no such element).');
    expect(await text('visualize', { view: 'machine', focus: ['sales.OrderFlow'], title: 'Order lifecycle' })).toEqual({ shown: true });
    expect(window.shown).toEqual([{ view: 'machine', focus: ['sales.OrderFlow'], title: 'Order lifecycle' }]);
    expect(await text('visual_selection', {})).toMatchObject({ open: true, qn: 'sales.OrderStatus.placed' });
    window.ask({ id: 'a1', text: 'Why?', selected: 'sales.OrderStatus.placed', view: window.shown[0] });
    await new Promise(done => setTimeout(done, 10));
    expect(notifications).toMatchObject([{
        method: 'notifications/claude/channel',
        params: { content: 'Why?', meta: { ask_id: 'a1', selected: 'sales.OrderStatus.placed', view: 'machine sales.OrderFlow' } }
    }]);
});

test('the MCP server without a visualizer has no visual tools and is no channel', async () => {
    const client = new Client({ name: 'test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([createMcpServer(workspace()).connect(serverTransport), client.connect(clientTransport)]);
    expect(client.getServerCapabilities()?.experimental).toBeUndefined();
    expect(client.getInstructions()).toContain('The model is the source of truth for business logic.');
    expect(client.getInstructions()).not.toContain('visual_reply');
    expect((await client.listTools()).tools.map(t => t.name)).not.toContain('visualize');
});

test('proposed edits are written only when the person accepts them in the window', async () => {
    const operations = [{ op: 'add', parent: 'crm.Account', source: 'phone: String?' }];
    const accepting = fakeWindow({ accepted: true });
    const root = workspace();
    const accepted = await (await visualClient(root, accepting.host)).text('propose_edits', { operations, summary: 'Add a phone number' });
    expect(accepted).toEqual({ accepted: true, ok: true, changed: ['crm.appling'] });
    expect(accepting.reviews[0]).toMatchObject({ summary: 'Add a phone number', hunks: [{ file: 'crm.appling', added: ['    phone: String?'] }], graph: { added: ['crm.Account.phone'] } });
    expect(readFileSync(join(root, 'crm.appling'), 'utf8')).toContain('phone: String?');

    const other = workspace();
    const before = readFileSync(join(other, 'crm.appling'), 'utf8');
    const rejecting = fakeWindow({ accepted: false, comment: 'Not now' });
    expect(await (await visualClient(other, rejecting.host)).text('propose_edits', { operations, summary: 'Add a phone number' })).toEqual({ accepted: false, comment: 'Not now' });
    expect(readFileSync(join(other, 'crm.appling'), 'utf8')).toBe(before);
    expect((await (await visualClient(other, rejecting.host)).text('propose_edits', { operations: [{ op: 'remove', target: 'crm.Nope' }], summary: 'x' })).ok).toBe(false);
});

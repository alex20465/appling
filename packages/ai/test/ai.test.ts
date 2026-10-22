import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { expect, test } from 'vitest';
import { writeRegistry } from '@appling/codegen';
import { chat, createMcpServer, MAX_ATTEMPTS, Project, type ChatEvent } from '../src/index.js';

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
    expect((await client.listTools()).tools.map(t => t.name).sort()).toEqual(['check', 'edit', 'graph_query', 'read_source', 'registry_next', 'registry_update', 'run_tests', 'simulate', 'write_model_file']);
    const text = async (name: string, args: Record<string, unknown>) => JSON.parse(((await client.callTool({ name, arguments: args })).content as { text: string }[])[0].text);
    expect(await text('check', {})).toEqual({ errors: [] });
    expect((await text('graph_query', { qn: 'sales.Order' })).contains).toContain('sales.Order.status');
    expect((await text('read_source', { qn: 'crm.Clerk' })).source).toBe('crm.appling:\nrole Clerk');
    expect(await text('edit', { operation: { op: 'rename', target: 'crm.Account.email', name: 'mail' } })).toEqual({ ok: true, changed: ['crm.appling'] });
    expect(readFileSync(join(root, 'crm.appling'), 'utf8')).toContain('mail: String');
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

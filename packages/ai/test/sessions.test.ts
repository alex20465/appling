import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, test } from 'vitest';
import {
    createMcpServer, findConflicts, MemorySessionStore, overlaps, remoteAppHost, RemoteSessionStore, serveAppHost, serveSessionStore,
    type AgentSession, type Channel, type IdeHost
} from '../src/index.js';

function workspace(): string {
    const root = mkdtempSync(join(tmpdir(), 'appling-sessions-'));
    cpSync(join(import.meta.dirname, '../../../examples'), root, { recursive: true });
    return root;
}

/** Two linked channels, delivering asynchronously like IPC. */
function channels(): [Channel, Channel] {
    const listeners: [Set<(m: unknown) => void>, Set<(m: unknown) => void>] = [new Set(), new Set()];
    const end = (own: number): Channel => ({
        send: message => setTimeout(() => listeners[1 - own].forEach(l => l(structuredClone(message)))),
        onMessage: listener => {
            listeners[own].add(listener);
            return () => listeners[own].delete(listener);
        }
    });
    return [end(0), end(1)];
}

async function connect(root: string, store: MemorySessionStore, id: string, host?: IdeHost) {
    const client = new Client({ name: 'agent', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([createMcpServer(root, { session: { id, store, host } }).connect(serverTransport), client.connect(clientTransport)]);
    const call = async (name: string, args: Record<string, unknown> = {}) => JSON.parse(((await client.callTool({ name, arguments: args })).content as { text: string }[])[0].text);
    return { client, call };
}

test('element claims overlap with their members and ancestors only', () => {
    expect(overlaps('sales.Order', 'sales.Order.status')).toBe(true);
    expect(overlaps('sales.Order.status', 'sales.Order')).toBe(true);
    expect(overlaps('sales.Order', 'sales.OrderFlow')).toBe(false);
});

test('a session claims, sets label and status, messages and ends with its claims', async () => {
    const store = new MemorySessionStore();
    const changes: AgentSession[][] = [];
    store.onChange(sessions => changes.push(sessions));
    const a = (await store.open({ name: 'Claude Code', repo: '/work/shop', workspace: 'w' })).session;
    const { session: b, token } = await store.open({ name: 'Codex', repo: '/work/shop', workspace: 'w' });
    const other = (await store.open({ name: 'Gemini', repo: '/work/other', workspace: 'x' })).session;
    expect(await store.authenticate(token)).toBe(b.id);
    expect(await store.authenticate('nope')).toBeUndefined();
    expect(a.color).not.toBe(b.color);

    await store.update(a.id, { label: 'Invoices', status: 'needs-input', note: 'Which currency?' });
    expect(await store.get(a.id)).toMatchObject({ label: 'Invoices', status: 'needs-input', note: 'Which currency?' });
    await expect(store.update(a.id, { status: 'sleeping' as never })).rejects.toThrow(/Unknown status/);

    await store.claim(a.id, { elements: ['sales.Order'], files: ['sales.appling'] });
    const self = (await store.get(b.id))!;
    expect(findConflicts(await store.list(), self, { elements: ['sales.Order.total'], files: ['/work/shop/sales.appling'] })).toEqual([
        { session: a.id, label: 'Invoices', claimed: 'sales.Order', touched: 'sales.Order.total' },
        { session: a.id, label: 'Invoices', claimed: '/work/shop/sales.appling', touched: '/work/shop/sales.appling' }
    ]);

    expect(await store.send(b.id, 'Invoices', 'May I add Order.discount?')).toBe(a.id);
    await expect(store.send(b.id, 'Gemini', 'hi')).rejects.toThrow(/No other session/);
    expect(await store.send(other.id, other.id, 'self').catch(e => e.message)).toMatch(/No other session/);
    expect((await store.get(a.id))!.unread).toBe(1);
    expect(await store.inbox(a.id)).toMatchObject([{ from: b.id, fromLabel: 'Codex', text: 'May I add Order.discount?' }]);
    expect(await store.inbox(a.id)).toEqual([]);

    await store.end(a.id);
    expect(findConflicts(await store.list(), self, { elements: ['sales.Order'] })).toEqual([]);
    expect(await store.authenticate(token)).toBe(b.id);
    expect(changes.at(-1)!.map(s => s.id)).toEqual([b.id, other.id]);
});

test('a store in another process is reached over a channel, with its changes', async () => {
    const store = new MemorySessionStore();
    const [parent, child] = channels();
    serveSessionStore(store, parent);
    const remote = new RemoteSessionStore(child);
    const changed = new Promise<AgentSession[]>(done => remote.onChange(done));
    const { session, token } = await remote.open({ name: 'Claude Code', repo: '/work/shop' });
    expect((await changed).map(s => s.id)).toEqual([session.id]);
    expect(await remote.authenticate(token)).toBe(session.id);
    await remote.claim(session.id, { elements: ['sales.Order'] });
    expect((await store.get(session.id))!.claims.elements).toEqual(['sales.Order']);
    await expect(remote.update('gone', { label: 'x' })).rejects.toThrow(/No session gone/);

    const [appSide, ideSide] = channels();
    serveAppHost({ context: async s => ({ activeRepo: s.repo }), act: async (_, a) => a.action === 'focus' }, appSide);
    const host = remoteAppHost(ideSide);
    expect(await host.context!(session)).toEqual({ activeRepo: '/work/shop' });
    expect(await host.act!(session, { action: 'focus' })).toBe(true);
    expect(await remoteAppHost(channels()[0], 50).context!(session)).toEqual({});
});

test('MCP tool calls are attributed to the session and edits on claimed elements come with a warning', async () => {
    const root = workspace();
    const store = new MemorySessionStore();
    const a = (await store.open({ name: 'Claude Code', repo: root })).session;
    const b = (await store.open({ name: 'Codex', repo: root })).session;
    const acts: unknown[] = [];
    const host: IdeHost = { context: async s => ({ repo: s.repo, selection: 'sales.Order' }), act: async (_, action) => { acts.push(action); return { ok: true }; } };
    const first = await connect(root, store, a.id, host);
    const second = await connect(root, store, b.id);

    const tools = (await first.client.listTools()).tools.map(t => t.name);
    expect(tools).toEqual(expect.arrayContaining(['session_set_label', 'session_set_status', 'session_claim', 'session_release', 'sessions_list', 'session_message', 'session_inbox', 'ide_context', 'ide_act']));
    // the instructions require checking claims and keeping label and status current (#16)
    for (const tool of ['session_set_label', 'session_set_status', 'sessions_list', 'session_claim', 'session_inbox']) expect(first.client.getInstructions()).toContain(tool);

    expect(await first.call('session_set_label', { label: 'Order totals' })).toMatchObject({ label: 'Order totals', status: 'working' });
    expect((await first.call('session_claim', { elements: ['sales.Order'] })).claims.elements).toEqual(['sales.Order']);
    expect((await store.get(a.id))!.active?.tool).toBe('session_claim');

    const claim = await second.call('session_claim', { elements: ['sales.Order.status'] });
    expect(claim.conflicts).toMatchObject([{ session: a.id, label: 'Order totals', claimed: 'sales.Order' }]);
    const edit = await second.call('edit', { operation: { op: 'add', parent: 'sales.Order', source: 'note: String?' }, dryRun: true });
    expect(edit).toMatchObject({ ok: true, conflicts: [{ session: a.id, claimed: 'sales.Order', touched: 'sales.Order' }] });
    expect(edit.warning).toContain('Order totals');
    expect((await second.call('edit', { operation: { op: 'add', parent: 'crm.Account', source: 'note: String?' }, dryRun: true })).warning).toBeUndefined();

    expect((await second.call('sessions_list')).others).toMatchObject([{ id: a.id, label: 'Order totals', claims: { elements: ['sales.Order'] } }]);
    expect(await second.call('session_message', { to: 'Order totals', text: 'I need Order.status' })).toEqual({ sent: true, to: a.id });
    expect((await first.call('check')).messages).toContain('1 unread message');
    expect((await first.call('session_inbox')).messages).toMatchObject([{ fromLabel: 'Codex', text: 'I need Order.status' }]);
    expect(await second.call('session_message', { to: 'nobody', text: 'x' })).toEqual({ error: 'No other session nobody in this workspace.' });

    expect(await first.call('ide_context')).toEqual({ repo: root, selection: 'sales.Order' });
    expect(await first.call('ide_act', { action: 'highlight', elements: ['sales.Order'] })).toEqual({ ok: true });
    expect(acts).toEqual([{ action: 'highlight', elements: ['sales.Order'] }]);
    expect(await second.call('ide_act', { action: 'focus' })).toMatchObject({ ok: false });

    expect(await first.call('session_set_status', { status: 'done', note: 'Totals added' })).toMatchObject({ status: 'done', note: 'Totals added' });
    expect((await first.call('session_release')).claims).toEqual({ elements: [], files: [] });
    await store.end(a.id);
    expect((await first.call('session_set_label', { label: 'x' })).error).toMatch(/has ended/);
});

test('agent sessions pick registry tasks other sessions have not claimed, claim them and release them when done', async () => {
    const root = workspace();
    writeFileSync(join(root, 'appling.config.json'), JSON.stringify({ generate: [{ extension: 'x', out: 'out' }] }));
    const entry = (qn: string) => ({ qn, kind: 'Entity', layer: 'domain', status: 'todo', steps: [], files: [], missing: [{ what: `write ${qn}`, context: { props: {}, related: [] } }] });
    mkdirSync(join(root, 'out/.appling'), { recursive: true });
    writeFileSync(join(root, 'out/.appling/tasks.json'), JSON.stringify({ extension: 'x', entries: { 'sales.Order': entry('sales.Order'), 'crm.Account': entry('crm.Account') } }));
    const store = new MemorySessionStore();
    const a = (await store.open({ name: 'Claude Code', repo: root })).session;
    const b = (await store.open({ name: 'Codex', repo: root })).session;
    const first = await connect(root, store, a.id);
    const second = await connect(root, store, b.id);

    expect(await first.call('registry_next')).toMatchObject({ claimed: 'sales.Order', entry: { qn: 'sales.Order' } });
    expect((await store.get(a.id))!.claims.elements).toEqual(['sales.Order']);
    expect(await second.call('registry_next')).toMatchObject({ claimed: 'crm.Account' });
    await store.release(b.id);
    expect((await second.call('registry_next')).claimed).toBe('crm.Account');

    expect(await first.call('registry_update', { qn: 'sales.Order', status: 'done' })).toMatchObject({ status: 'done', attempts: 1 });
    expect((await store.get(a.id))!.claims.elements).toEqual([]);
    expect(await first.call('registry_next')).toEqual({ done: 'No open tasks that other sessions have not claimed.' });
    expect(await first.call('registry_update', { qn: 'nope', status: 'done' })).toEqual({ error: 'No registry entry nope.' });

    const status = await first.call('implementation_status', { module: 'sales' });
    expect(status.counts.unimplemented).toBeGreaterThan(0);
    expect(status.elements[0]).toMatchObject({ state: expect.any(String), outstanding: true });
});

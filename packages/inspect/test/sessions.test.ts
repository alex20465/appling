import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import { startInspect, type Inspect } from '../src/server/server.js';

let inspect: Inspect;
let root: string;

beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'appling-inspect-sessions-'));
    cpSync(join(import.meta.dirname, '../../../examples'), root, { recursive: true });
    inspect = await startInspect(root, 0, { host: { context: async () => ({ workspace: '/work/shop.code-workspace' }), act: async (_, a) => a.action === 'focus' } });
});

afterAll(() => inspect.close());

/** An agent's MCP client over the inspector's Streamable HTTP endpoint, with its session token. */
async function agent(token: string) {
    const client = new Client({ name: 'agent', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(inspect.mcp), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const call = async (name: string, args: Record<string, unknown> = {}) => JSON.parse(((await client.callTool({ name, arguments: args })).content as { text: string }[])[0].text);
    return { client, call };
}

type Message = { type: string, [key: string]: unknown };

/** The /events socket, collecting every message. */
async function events() {
    const socket = new WebSocket(inspect.url.replace('http', 'ws') + '/events', { origin: inspect.url });
    const messages: Message[] = [];
    const waiters: (() => void)[] = [];
    socket.on('message', data => {
        messages.push(JSON.parse(data.toString()));
        waiters.splice(0).forEach(w => w());
    });
    await new Promise(resolve => socket.on('open', resolve));
    const next = async (match: (m: Message) => boolean) => {
        for (;;) {
            const found = messages.find(match);
            if (found) return found;
            await new Promise<void>(done => waiters.push(done));
        }
    };
    return { socket, next };
}

test('the MCP endpoint needs a session token', async () => {
    const response = await fetch(inspect.mcp, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
    expect(response.status).toBe(401);
    expect((await fetch(inspect.mcp, { method: 'POST', headers: { authorization: 'Bearer wrong' }, body: '{}' })).status).toBe(401);
    expect((await fetch(inspect.mcp, { method: 'POST', headers: { authorization: 'Bearer wrong', origin: 'https://evil.example' }, body: '{}' })).status).toBe(403);
});

test('two agent sessions label, claim, warn on conflicts and message each other over HTTP', async () => {
    const watch = await events();
    const opened = await (await fetch(`${inspect.url}/api/sessions`, { method: 'POST', body: JSON.stringify({ name: 'Claude Code' }) })).json();
    expect(opened.mcp).toBe(inspect.mcp);
    const second = await inspect.sessions.open({ name: 'Codex', repo: root });
    const a = await agent(opened.token);
    const b = await agent(second.token);

    expect(a.client.getInstructions()).toContain('sessions_list');
    expect(await a.call('session_set_label', { label: 'Order totals' })).toMatchObject({ id: opened.session.id, label: 'Order totals' });
    const pushed = await watch.next(m => m.type === 'sessions' && (m.sessions as { label?: string }[]).some(s => s.label === 'Order totals'));
    expect(pushed.sessions).toHaveLength(2);

    await a.call('session_claim', { elements: ['sales.Order'], files: ['crm.appling'] });
    const edit = await b.call('edit', { operation: { op: 'rename', target: 'crm.Account.email', name: 'mail' } });
    expect(edit.ok).toBe(true);
    expect(edit.conflicts).toEqual([{ session: opened.session.id, label: 'Order totals', claimed: join(root, 'crm.appling'), touched: join(root, 'crm.appling') }]);
    expect((await b.call('edit', { operation: { op: 'remove', target: 'sales.Order.nope' }, dryRun: true })).ok).toBe(false);
    expect((await b.call('edit', { operation: { op: 'add', parent: 'sales.Order', source: 'note: String?' }, dryRun: true })).warning).toContain('Order totals');
    expect((await inspect.sessions.get(second.session.id))!.active?.tool).toBe('edit');

    expect(await b.call('session_message', { to: opened.session.id, text: 'Please release crm.appling' })).toMatchObject({ sent: true });
    expect((await a.call('sessions_list')).messages).toContain('1 unread');
    expect((await a.call('session_inbox')).messages).toMatchObject([{ from: second.session.id, text: 'Please release crm.appling' }]);
    await a.call('session_release', { files: ['crm.appling'] });
    expect((await b.call('sessions_list')).others[0].claims).toEqual({ elements: ['sales.Order'], files: [] });

    // The user renames a session's tab; ending a session ends its claims and its token.
    expect((await (await fetch(`${inspect.url}/api/sessions/${second.session.id}`, { method: 'PATCH', body: JSON.stringify({ label: 'Account email' }) })).json()).label).toBe('Account email');
    expect((await fetch(`${inspect.url}/api/sessions/${opened.session.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await b.call('sessions_list')).others).toEqual([]);
    expect((await fetch(inspect.mcp, { method: 'POST', headers: { authorization: `Bearer ${opened.token}` }, body: '{}' })).status).toBe(401);
    await inspect.sessions.end(second.session.id);
    watch.socket.close();
});

test('ide_context reads what the client shows and ide_act reaches the client and the app', async () => {
    const watch = await events();
    watch.socket.send(JSON.stringify({ type: 'context', selection: 'sales.Order', view: { lens: 'domain' } }));
    const { session, token } = await inspect.sessions.open({ name: 'Claude Code', repo: root });
    const a = await agent(token);
    expect(await a.call('ide_context')).toMatchObject({ repo: root, workspace: '/work/shop.code-workspace', selection: 'sales.Order', view: { lens: 'domain' }, tab: { id: session.id, title: 'Claude Code' } });
    expect(await a.call('ide_act', { action: 'highlight', elements: ['sales.Order'] })).toEqual({ ok: true });
    expect(await watch.next(m => m.type === 'act')).toEqual({ type: 'act', session: session.id, color: session.color, action: 'highlight', elements: ['sales.Order'] });
    expect(await a.call('ide_act', { action: 'focus' })).toEqual({ ok: true });
    expect((await a.call('ide_act', { action: 'reveal' })).ok).toBe(false);
    await inspect.sessions.end(session.id);
    watch.socket.close();
});

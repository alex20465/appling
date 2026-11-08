import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, expect, test } from 'vitest';
import { agentSessions, desktopHost, openAgentSession } from '../src/agent-sessions.js';
import { startIdeProcess, type IdeProcess } from '../src/ide-process.js';
import { Workspaces } from '../src/workspaces.js';
import { MemoryPlaybookStore } from '@appling/ai';
import { desktopPlaybooks } from '../src/playbooks.js';

const processes: IdeProcess[] = [];
afterEach(() => processes.splice(0).forEach(p => p.close()));

function repo(): string {
    const root = mkdtempSync(join(tmpdir(), 'appling-desktop-sessions-'));
    cpSync(join(import.meta.dirname, '../../../examples'), root, { recursive: true });
    return root;
}

async function agent(mcp: string, headers: Record<string, string>) {
    const client = new Client({ name: 'agent', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(mcp), { requestInit: { headers } }));
    return async (name: string, args: Record<string, unknown> = {}) => JSON.parse(((await client.callTool({ name, arguments: args })).content as { text: string }[])[0].text);
}

test('the repo servers of a workspace share the agent sessions of the main process', async () => {
    const [shop, crm] = [repo(), repo()];
    const workspaces = new Workspaces();
    const file = join(tmpdir(), 'team.code-workspace');
    workspaces.open(file, [{ path: shop, name: 'shop' }, { path: crm, name: 'crm' }]);
    workspaces.select(shop, file);
    const store = agentSessions();
    const focused: string[] = [];
    const host = desktopHost(workspaces, { focus: session => { focused.push(session.id); return true; } });
    const started = await Promise.all([shop, crm].map(root => startIdeProcess(root, { sessions: store, host })));
    processes.push(...started);

    const a = await openAgentSession(store, { name: 'Claude Code', repo: shop, workspace: file, mcp: started[0].mcp });
    const b = await openAgentSession(store, { name: 'Codex', repo: crm, workspace: file, mcp: started[1].mcp });
    const callA = await agent(a.mcp, a.headers);
    const callB = await agent(b.mcp, b.headers);

    await callA('session_set_label', { label: 'Shop orders' });
    await callA('session_claim', { elements: ['sales.Order'], files: ['sales.appling'] });
    expect((await store.get(a.session.id))!).toMatchObject({ label: 'Shop orders', claims: { elements: ['sales.Order'], files: [join(shop, 'sales.appling')] }, active: { tool: 'session_claim' } });

    // Across repos the file claims count; the element claims belong to the other repo's model.
    expect((await callB('sessions_list')).others).toMatchObject([{ id: a.session.id, label: 'Shop orders', repo: shop }]);
    expect((await callB('edit', { operation: { op: 'add', parent: 'sales.Order', source: 'note: String?' }, dryRun: true })).warning).toBeUndefined();
    expect(await callB('session_message', { to: 'Shop orders', text: 'Ready for the CRM side?' })).toEqual({ sent: true, to: a.session.id });
    expect((await callA('session_inbox')).messages).toMatchObject([{ fromLabel: 'Codex', text: 'Ready for the CRM side?' }]);

    expect(await callB('ide_context')).toMatchObject({ repo: crm, activeRepo: shop, workspace: file, tab: { id: b.session.id } });
    expect(await callB('ide_act', { action: 'focus' })).toEqual({ ok: true });
    expect(focused).toEqual([b.session.id]);

    await store.end(a.session.id);
    expect((await callB('sessions_list')).others).toEqual([]);
}, 60000);

test('the sessions of all repos of a workspace write one playbook in the main process, kept in the data folder', async () => {
    const [shop, crm] = [repo(), repo()];
    const workspaces = new Workspaces();
    const file = join(tmpdir(), 'playbook-team.code-workspace');
    workspaces.open(file, [{ path: shop, name: 'shop' }, { path: crm, name: 'crm' }]);
    workspaces.select(shop, file);
    const store = agentSessions();
    const folder = mkdtempSync(join(tmpdir(), 'appling-desktop-playbooks-'));
    const playbooks = desktopPlaybooks(folder);
    const host = desktopHost(workspaces);
    const started = await Promise.all([shop, crm].map(root => startIdeProcess(root, { sessions: store, playbooks, host })));
    processes.push(...started);

    const a = await openAgentSession(store, { name: 'Claude Code', repo: shop, workspace: file, mcp: started[0].mcp });
    const b = await openAgentSession(store, { name: 'Codex', repo: crm, workspace: file, mcp: started[1].mcp });
    const callA = await agent(a.mcp, a.headers);
    const callB = await agent(b.mcp, b.headers);
    const first = await callA('playbook_open_chapter', { title: 'Orders', plan: 'Shop side', steps: [{ elements: ['sales.Order'], change: 'change', note: 'Discount' }] });
    const second = await callB('playbook_open_chapter', { title: 'Accounts', plan: 'CRM side', refs: [first.chapter.id] });
    expect(second.queued.map((c: { title: string }) => c.title)).toEqual(['Orders', 'Accounts']);

    // the crm view plays the workspace's playbook, with the shop's chapter in it
    const read = await (await fetch(`${started[1].url}/api/playbook`)).json();
    expect(read).toMatchObject({ workspace: file, chapters: [{ title: 'Orders', repo: shop }, { title: 'Accounts', repo: crm, refs: [first.chapter.id] }] });
    const respond = { method: 'POST', body: JSON.stringify({ chapter: first.chapter.id, step: 1, kind: 'approve' }) };
    expect(await (await fetch(`${started[1].url}/api/playbook/respond`, respond)).json()).toEqual({ ok: true, delivered: true });
    expect((await callA('session_inbox')).messages).toMatchObject([{ fromLabel: 'User', text: expect.stringMatching(/approved step 1/) }]);

    // the playbook outlives the sessions and the app
    await store.end(a.session.id);
    await store.end(b.session.id);
    expect((await new MemoryPlaybookStore(folder).read(file)).chapters.map(c => c.title)).toEqual(['Orders', 'Accounts']);
}, 60000);

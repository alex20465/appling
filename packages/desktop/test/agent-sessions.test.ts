import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, expect, test } from 'vitest';
import { agentSessions, desktopHost, openAgentSession } from '../src/agent-sessions.js';
import { startIdeProcess, type IdeProcess } from '../src/ide-process.js';
import { Workspaces } from '../src/workspaces.js';

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

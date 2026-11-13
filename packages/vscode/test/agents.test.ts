import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySessionStore } from '@appling/ai';
import { BUILTIN_PRESETS, type AgentPreset } from '@appling/ai/agents';
import { afterEach, expect, test } from 'vitest';
import { Agents, type TerminalEvents, type TerminalSpec } from '../src/agents.js';

const preset = (name: string) => BUILTIN_PRESETS.find(p => p.name === name)!;
let agents: Agents | undefined;
afterEach(() => agents?.dispose());

function setup() {
    const store = new MemorySessionStore();
    const terminals: { spec: TerminalSpec, events: TerminalEvents, written: string[], shown: number, disposed: boolean }[] = [];
    const folder = mkdtempSync(join(tmpdir(), 'appling-agents-'));
    const ran: string[] = [];
    agents = new Agents({
        store, folder, hookScript: '/ext/out/hook.cjs', workspace: '/w',
        ideMcp: repo => repo === '/w/shop' ? 'http://127.0.0.1:9/mcp' : undefined,
        run: async (command, args, cwd) => { ran.push([command, ...args, cwd].join(' ')); },
        terminals: (spec, events) => {
            const terminal = { spec, events, written: [] as string[], shown: 0, disposed: false };
            terminals.push(terminal);
            return { write: data => terminal.written.push(data), show: () => terminal.shown++, visible: () => false, dispose: () => terminal.disposed = true };
        }
    });
    return { store, terminals, folder, agents, ran };
}

test('a Claude Code session is wired to the gateway, waits through its hooks, is answered and exits', async () => {
    const { store, terminals, folder, agents } = setup();
    await agents.start();
    const waited: string[] = [];
    agents.on('waiting', record => waited.push(record.id));
    await expect(agents.create('/w/crm', preset('Claude Code'))).rejects.toThrow(/not running/);
    const record = await agents.create('/w/shop', preset('Claude Code'));
    const [terminal] = terminals;
    expect(terminal.spec).toMatchObject({ name: 'Claude Code', cwd: '/w/shop', command: 'claude', color: record.color });
    expect((await store.get(record.id))?.workspace).toBe('/w');
    const mcp = JSON.parse(readFileSync(terminal.spec.args[terminal.spec.args.indexOf('--mcp-config') + 1], 'utf8'));
    expect(mcp.mcpServers.appling.url).toBe(agents.gateway.mcpUrl);
    const response = await fetch(`${agents.gateway.hookUrl}/PermissionRequest`, {
        method: 'POST', headers: { authorization: mcp.mcpServers.appling.headers.Authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'pnpm test' } })
    });
    expect(response.status).toBe(200);
    expect(agents.get(record.id)).toMatchObject({ status: 'needs-input', prompt: { kind: 'permission', message: 'Allow Bash: pnpm test?' } });
    expect(waited).toEqual([record.id]);
    expect((await store.get(record.id))?.status).toBe('needs-input');
    expect(agents.answer(record.id, { kind: 'allow' })).toBe(true);
    expect(terminal.written).toEqual(['\r']);
    expect(agents.get(record.id)?.status).toBe('working');
    expect(agents.focus(record.id)).toBe(true);
    expect(terminal.shown).toBe(1);
    terminal.events.exit(0);
    expect(agents.get(record.id)?.status).toBe('exited');
    expect(await store.get(record.id)).toBeUndefined();
    expect(existsSync(join(folder, record.id))).toBe(false);
});

test('an agent wired by environment waits through its terminal notifications; closing the terminal ends the session', async () => {
    const { store, terminals, agents } = setup();
    await agents.start();
    const env: AgentPreset = { name: 'Aider', command: 'aider', args: ['--mcp', '{mcpUrl}'], env: {}, wiring: 'env', answers: preset('Claude Code').answers, builtin: false };
    const record = await agents.create('/w/shop', env);
    const [terminal] = terminals;
    expect(terminal.spec.args).toEqual(['--mcp', agents.gateway.mcpUrl]);
    expect(terminal.spec.env).toMatchObject({ APPLING_SESSION: record.id, APPLING_MCP_URL: agents.gateway.mcpUrl });
    terminal.events.notification({ title: 'Aider', body: 'Confirm?', source: 'osc777' });
    expect(agents.get(record.id)).toMatchObject({ status: 'needs-input', note: 'Aider: Confirm?' });
    await store.update(record.id, { label: 'Fix the order totals' });
    expect(agents.title(agents.get(record.id)!)).toBe('Fix the order totals');
    terminal.events.exit(undefined);
    await expect.poll(() => agents.get(record.id)).toBeUndefined();
    expect(await store.get(record.id)).toBeUndefined();
    expect(terminal.disposed).toBe(true);
});

test('an agent the user started gets the MCP server through its own command until its session ends', async () => {
    const { store, agents, ran } = setup();
    await agents.start();
    expect(agents.attachable(preset('Claude Code'))).toBe(true);
    expect(agents.attachable(preset('Codex'))).toBe(false);
    let disposed = false;
    const record = await agents.adopt('/w/shop', '/w/shop/api', preset('Claude Code'), { write: () => undefined, show: () => undefined, visible: () => true, dispose: () => { disposed = true; } });
    const token = /Bearer (\S+)/.exec(ran[1])![1];
    expect(ran).toEqual(['claude mcp remove --scope local appling /w/shop/api', `claude mcp add --scope local --transport http appling ${agents.gateway.mcpUrl} --header Authorization: Bearer ${token} /w/shop/api`]);
    expect(await store.authenticate(token)).toBe(record.id);
    expect(agents.focus(record.id)).toBe(true);
    await agents.close(record.id);
    expect(ran.at(-1)).toBe('claude mcp remove --scope local appling /w/shop/api');
    expect(disposed).toBe(false);
    expect(await store.get(record.id)).toBeUndefined();
});

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySessionStore } from '@appling/ai';
import { PtyHostClient } from '@appling/pty-host';
import { afterAll, describe, expect, test } from 'vitest';
import { boardEntries, formatDuration, railSessions, shouldNotify, type SessionView } from '../src/agents/board.js';
import { agentPresets, type AgentPreset } from '@appling/ai/agents';
import { AgentSessions } from '../src/agents/sessions.js';
import { startIdeProcess, type IdeProcess } from '../src/ide-process.js';
import { TerminalService } from '../src/terminal/service.js';

const temps: string[] = [];
function temp(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    temps.push(dir);
    return dir;
}

describe('board', () => {
    const now = new Date('2026-11-08T12:00:00Z');
    const view = (id: string, status: SessionView['status'], extra: Partial<SessionView> = {}): SessionView => ({
        id, name: 'Claude Code', status, color: '#2f9e44', repo: '/r/shop', workspace: '/w/team.code-workspace', started: '2026-11-08T11:00:00Z', ...extra
    });

    test('lists every session, the waiting ones first, with title, status colour, repo, duration and unwatched chapters', () => {
        const entries = boardEntries([
            view('a', 'done', { label: 'Orders', started: '2026-11-08T09:30:00Z' }),
            view('b', 'needs-input', { repo: '/r/crm', prompt: { kind: 'permission', message: 'Allow?', at: '' } }),
            view('c', 'exited', { started: '2026-11-08T11:58:00Z', ended: '2026-11-08T11:59:30Z' }),
            view('d', 'working', { label: 'Invoices' })
        ], { repoName: repo => repo.split('/').pop()!, workspaceName: () => 'team', unwatched: { d: 2 }, active: 'd', now });
        expect(entries.map(e => [e.id, e.title, e.status, e.statusColor, e.repoName, e.workspaceName, e.duration, e.unwatched, e.active])).toEqual([
            ['b', 'Claude Code', 'needs-input', '#e5a84f', 'crm', 'team', '1h 00m', 0, false],
            ['d', 'Invoices', 'working', '#5cbf63', 'shop', 'team', '1h 00m', 2, true],
            ['a', 'Orders', 'done', '#8a8174', 'shop', 'team', '2h 30m', 0, false],
            ['c', 'Claude Code', 'exited', '#8a8174', 'shop', 'team', '1m', 0, false]
        ]);
        expect(railSessions([view('a', 'working'), view('b', 'failed'), view('x', 'working', { repo: '/r/crm' })], '/r/shop', 'a'))
            .toEqual([{ id: 'b', title: 'Claude Code', status: 'failed', statusColor: '#e5684f', color: '#2f9e44', active: false }, { id: 'a', title: 'Claude Code', status: 'working', statusColor: '#5cbf63', color: '#2f9e44', active: true }]);
    });

    test('durations', () => {
        expect([0, 42_000, 5 * 60_000, 65 * 60_000, 51 * 3600_000].map(formatDuration)).toEqual(['0s', '42s', '5m', '1h 05m', '2d 3h']);
    });

    test('a waiting session notifies when its repo, workspace or tab is not in view, or the app is in the background', () => {
        const session = view('a', 'needs-input');
        const seen = { focused: true, shown: new Set(['/r/shop']), workspaces: new Set(['/w/team.code-workspace']), visible: new Set(['a']) };
        expect(shouldNotify(session, seen)).toBe(false);
        expect(shouldNotify(session, { ...seen, focused: false })).toBe(true);
        expect(shouldNotify(session, { ...seen, shown: new Set() })).toBe(true);
        expect(shouldNotify(session, { ...seen, workspaces: new Set() })).toBe(true);
        expect(shouldNotify(session, { ...seen, visible: new Set() })).toBe(true);
        expect(shouldNotify(view('a', 'working'), { ...seen, focused: false })).toBe(false);
    });
});


describe.skipIf(process.platform === 'win32')('agent sessions in a pty host', { timeout: 60000 }, () => {
    const hosts: string[] = [];
    const ides: IdeProcess[] = [];
    afterAll(async () => {
        for (const ide of ides) ide.close();
        for (const dir of hosts) {
            const client = await PtyHostClient.connect(dir).catch(() => undefined);
            await client?.shutdown().catch(() => undefined);
        }
        for (const dir of temps) rmSync(dir, { recursive: true, force: true });
    });

    async function until<T>(check: () => T | undefined | false, debug?: () => string, timeout = 20000): Promise<T> {
        const deadline = Date.now() + timeout;
        for (;;) {
            const value = check();
            if (value) return value;
            if (Date.now() > deadline) throw new Error(`Timed out.${debug ? `\n${debug()}` : ''}`);
            await new Promise(done => setTimeout(done, 25));
        }
    }

    const FAKE = join(import.meta.dirname, 'fixtures/fake-agent.mjs');
    const presets = (): AgentPreset[] => agentPresets({
        'agents.presets': [
            { name: 'Fake Claude', command: process.execPath, args: [FAKE], wiring: 'claude' },
            { name: 'Fake', command: process.execPath, args: [FAKE] }
        ]
    }).presets;

    function setup() {
        const host = temp('agents-pty-');
        hosts.push(host);
        const repo = temp('agents-repo-');
        cpSync(join(import.meta.dirname, '../../../examples'), repo, { recursive: true });
        const data = temp('agents-data-');
        const terminals = () => new TerminalService({
            host: { dir: host }, registryFile: join(data, 'terminals.json'),
            env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: repo }
        });
        const sessions = (store: MemorySessionStore, service: TerminalService, ide: IdeProcess) => new AgentSessions({
            store, terminals: service, folder: join(data, 'agents'), ideMcp: () => ide.mcp, presets
        });
        return { repo, data, terminals, sessions };
    }

    test('a Claude Code style agent reaches MCP and its hooks, survives a restart of the app, is answered and exits', async () => {
        const { repo, data, terminals, sessions } = setup();
        const store = new MemorySessionStore();
        const ide = await startIdeProcess(repo, { sessions: store });
        ides.push(ide);
        const service = terminals();
        let output = '';
        service.on('data', (_, chunk) => output += chunk);
        const agents = sessions(store, service, ide);
        await agents.start();
        const waiting: string[] = [];
        agents.on('waiting', record => waiting.push(record.id));
        const record = await agents.create(repo, 'Fake Claude', { workspace: '/w/team.code-workspace' });
        expect(record).toMatchObject({ name: 'Fake Claude', wiring: 'claude', repo, workspace: '/w/team.code-workspace' });
        expect(service.registry.terminals(repo)).toEqual([record.terminal]);
        const files = join(data, 'agents', 'sessions', record.id);
        expect(statSync(join(files, 'mcp.json')).mode & 0o777).toBe(0o600);

        await until(() => agents.get(record.id)?.status === 'needs-input', () => output);
        expect(agents.get(record.id)).toMatchObject({ label: 'Fake work', note: 'Allow Bash: rm -rf build?', prompt: { kind: 'permission', message: 'Allow Bash: rm -rf build?' }, claims: { elements: ['sales.Order'] } });
        expect(await store.get(record.id)).toMatchObject({ label: 'Fake work', status: 'needs-input' });
        expect(waiting).toEqual([record.id]);
        expect(agents.rail(repo)).toMatchObject([{ id: record.id, title: 'Fake work', status: 'needs-input', active: true }]);
        expect(agents.tabs(repo)[record.terminal]).toMatchObject({ session: record.id, title: 'Fake work', status: 'needs-input' });
        const port = agents.gateway.port;

        // the app quits; the agent keeps running in the pty host and waits
        agents.dispose();
        service.dispose();
        const store2 = new MemorySessionStore();
        const ide2 = await startIdeProcess(repo, { sessions: store2 });
        ides.push(ide2);
        const service2 = terminals();
        let output2 = '';
        service2.on('data', (_, chunk) => output2 += chunk);
        const agents2 = sessions(store2, service2, ide2);
        await agents2.start();
        expect(agents2.gateway.port).toBe(port);
        expect(await store2.get(record.id)).toMatchObject({ label: 'Fake work', status: 'needs-input', claims: { elements: ['sales.Order'] } });
        await service2.openRepo(repo);

        expect(agents2.answer(record.id, { kind: 'allow' })).toBe(true);
        await until(() => agents2.get(record.id)?.status === 'done', () => output2);
        expect(output2).toContain('answer:""');
        expect(agents2.get(record.id)).toMatchObject({ note: 'All done' });
        expect(agents2.get(record.id)?.prompt).toBeUndefined();

        agents2.answer(record.id, { kind: 'reply', text: 'thanks' });
        await until(() => agents2.get(record.id)?.status === 'exited', () => output2);
        expect(output2).toContain('reply:"thanks"');
        expect(agents2.get(record.id)).toMatchObject({ exit: { code: 0 }, note: 'Exited with code 0' });
        // the MCP session and its claims end with the agent; the tab stays with its scrollback, the token goes
        expect(await store2.get(record.id)).toBeUndefined();
        expect(service2.registry.terminals(repo)).toEqual([record.terminal]);
        expect(existsSync(files)).toBe(false);
        expect(JSON.parse(readFileSync(join(data, 'agents', 'sessions.json'), 'utf8')).sessions[0]).toMatchObject({ id: record.id, status: 'exited' });

        await agents2.close(record.id);
        expect(agents2.list()).toEqual([]);
        expect(service2.registry.terminals(repo)).toEqual([]);
        agents2.dispose();
        service2.dispose();
    });

    test('an agent wired by environment waits through OSC 9; typing Enter answers it; closing its tab ends the session', async () => {
        const { repo, terminals, sessions } = setup();
        const store = new MemorySessionStore();
        const ide = await startIdeProcess(repo, { sessions: store });
        ides.push(ide);
        const service = terminals();
        let output = '';
        service.on('data', (_, chunk) => output += chunk);
        const agents = sessions(store, service, ide);
        await agents.start();
        const record = await agents.create(repo, 'Fake');
        await until(() => agents.get(record.id)?.status === 'needs-input', () => output);
        expect(agents.get(record.id)).toMatchObject({ label: 'Fake work', prompt: { kind: 'input', message: 'Approval wanted' } });
        // the user types Enter in the terminal tab
        service.write(record.terminal, '\r');
        expect(agents.get(record.id)?.status).toBe('working');
        await until(() => agents.get(record.id)?.note === 'after the answer', () => output);
        await agents.rename(record.id, 'Renamed by me');
        expect((await store.get(record.id))?.label).toBe('Renamed by me');
        await service.kill(record.terminal);
        await until(() => !agents.get(record.id));
        expect(await store.get(record.id)).toBeUndefined();
        await expect(agents.create(repo, 'Nope')).rejects.toThrow('There is no agent preset "Nope".');
        agents.dispose();
        service.dispose();
    });

    test('two sessions in one repo run side by side in their own tabs; the user renames a running and an exited one', async () => {
        const { repo, data, terminals, sessions } = setup();
        const store = new MemorySessionStore();
        const ide = await startIdeProcess(repo, { sessions: store });
        ides.push(ide);
        const service = terminals();
        let output = '';
        service.on('data', (_, chunk) => output += chunk);
        const agents = sessions(store, service, ide);
        await agents.start();
        const first = await agents.create(repo, 'Fake');
        const second = await agents.create(repo, 'Fake');
        expect(first.id).not.toBe(second.id);
        expect(first.terminal).not.toBe(second.terminal);
        // each in its own tab of the repo's panel
        const tabs = service.registry.get(repo).tabs;
        expect(tabs.map(t => t.panes)).toEqual([[first.terminal], [second.terminal]]);
        await until(() => agents.get(first.id)?.status === 'needs-input' && agents.get(second.id)?.status === 'needs-input', () => output);
        // each reached MCP as its own session
        expect((await store.get(first.id))?.label).toBe('Fake work');
        expect((await store.get(second.id))?.label).toBe('Fake work');
        expect(agents.rail(repo).map(r => r.id).sort()).toEqual([first.id, second.id].sort());

        // answering one leaves the other waiting
        service.write(first.terminal, '\r');
        await until(() => agents.get(first.id)?.note === 'after the answer', () => output);
        expect(agents.get(second.id)?.status).toBe('needs-input');

        // a running session renamed: its MCP label, its tab and the rail follow
        await agents.rename(first.id, 'Checkout fix');
        expect((await store.get(first.id))?.label).toBe('Checkout fix');
        await until(() => agents.get(first.id)?.label === 'Checkout fix');
        expect(agents.tabs(repo)[first.terminal]).toMatchObject({ session: first.id, title: 'Checkout fix' });
        expect(agents.rail(repo).find(r => r.id === first.id)).toMatchObject({ title: 'Checkout fix' });
        expect(agents.tabs(repo)[second.terminal]).toMatchObject({ session: second.id, title: 'Fake work' });

        // the second one exits; renamed then, the label stays on its gray tab and in the saved sessions
        service.write(second.terminal, '\r');
        await until(() => agents.get(second.id)?.note === 'after the answer', () => output);
        service.write(second.terminal, 'bye\r');
        await until(() => agents.get(second.id)?.status === 'exited', () => output);
        expect(await store.get(second.id)).toBeUndefined();
        await agents.rename(second.id, 'Old attempt');
        expect(agents.get(second.id)).toMatchObject({ status: 'exited', label: 'Old attempt' });
        expect(agents.tabs(repo)[second.terminal]).toMatchObject({ title: 'Old attempt', status: 'exited' });
        await until(() => JSON.parse(readFileSync(join(data, 'agents', 'sessions.json'), 'utf8')).sessions.find((r: { id: string }) => r.id === second.id)?.label === 'Old attempt');
        // an empty name gives the session its agent's name back
        await agents.rename(second.id, '  ');
        expect(agents.get(second.id)?.label).toBeUndefined();
        expect(agents.get(first.id)?.status).not.toBe('exited');

        await agents.close(first.id);
        await agents.close(second.id);
        expect(agents.list()).toEqual([]);
        agents.dispose();
        service.dispose();
    });
});

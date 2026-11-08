import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySessionStore } from '@appling/ai';
import { PtyHostClient } from '@appling/pty-host';
import { afterAll, describe, expect, test } from 'vitest';
import { boardEntries, formatDuration, railSessions, shouldNotify, type SessionView } from '../src/agents/board.js';
import { Gateway } from '../src/agents/gateway.js';
import { agentPresets, answerKeys, BUILTIN_PRESETS, CLAUDE_HOOKS, isAnswer, launch, OPENCODE_PLUGIN, type AgentPreset, type LaunchContext } from '../src/agents/presets.js';
import { AgentSessions } from '../src/agents/sessions.js';
import { answers, hookSignal, notificationSignal, reduce, type StatusState } from '../src/agents/status.js';
import { startIdeProcess, type IdeProcess } from '../src/ide-process.js';
import { TerminalService } from '../src/terminal/service.js';

const temps: string[] = [];
function temp(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    temps.push(dir);
    return dir;
}

const preset = (name: string) => BUILTIN_PRESETS.find(p => p.name === name)!;
const context: LaunchContext = {
    session: 's1', mcpUrl: 'http://127.0.0.1:4100/mcp', hookUrl: 'http://127.0.0.1:4100/hooks', token: 'tok', dir: '/data/agents/sessions/s1', hookScript: '/app/out/agents/hook.cjs'
};

describe('presets', () => {
    test('Claude Code gets an HTTP MCP server with a bearer header and HTTP hooks through its flags', () => {
        const started = launch(preset('Claude Code'), context);
        expect(started.command).toBe('claude');
        expect(started.args).toEqual(['--mcp-config', '/data/agents/sessions/s1/mcp.json', '--settings', '/data/agents/sessions/s1/settings.json']);
        expect(JSON.parse(started.files['/data/agents/sessions/s1/mcp.json'])).toEqual({
            mcpServers: { appling: { type: 'http', url: 'http://127.0.0.1:4100/mcp', headers: { Authorization: 'Bearer tok' } } }
        });
        const settings = JSON.parse(started.files['/data/agents/sessions/s1/settings.json']);
        expect(Object.keys(settings.hooks)).toEqual([...CLAUDE_HOOKS]);
        expect(settings.hooks.PermissionRequest).toEqual([{ hooks: [{ type: 'http', url: 'http://127.0.0.1:4100/hooks/PermissionRequest', timeout: 5, headers: { Authorization: 'Bearer tok' } }] }]);
        expect(started.env).toMatchObject({ APPLING_SESSION: 's1', APPLING_MCP_URL: context.mcpUrl, APPLING_MCP_TOKEN: 'tok', APPLING_HOOK_URL: context.hookUrl });
    });

    test('Codex gets -c overrides with the token from the environment and OSC 9 notifications', () => {
        const started = launch(preset('Codex'), context);
        expect(started.args).toEqual([
            '-c', 'mcp_servers.appling.url="http://127.0.0.1:4100/mcp"',
            '-c', 'mcp_servers.appling.bearer_token_env_var="APPLING_MCP_TOKEN"',
            '-c', 'tui.notifications=true', '-c', 'tui.notification_method="osc9"', '-c', 'tui.notification_condition="always"'
        ]);
        expect(started.files).toEqual({});
        expect(started.env.APPLING_MCP_TOKEN).toBe('tok');
    });

    test('Gemini CLI gets its own system settings over the machine\'s, with command hooks', () => {
        const started = launch(preset('Gemini CLI'), { ...context, geminiSystemSettings: { mcpServers: { other: { command: 'x' } }, hooks: { AfterAgent: [{ hooks: [{ type: 'command', command: 'mine' }] }] }, ui: { theme: 'dark' } } });
        const file = '/data/agents/sessions/s1/gemini-settings.json';
        expect(started.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBe(file);
        expect(started.files['/data/agents/sessions/s1/token']).toBe('tok');
        const settings = JSON.parse(started.files[file]);
        expect(settings.ui).toEqual({ theme: 'dark' });
        expect(settings.mcpServers).toEqual({ other: { command: 'x' }, appling: { httpUrl: context.mcpUrl, headers: { Authorization: 'Bearer tok' } } });
        expect(settings.hooksConfig).toEqual({ enabled: true });
        expect(settings.hooks.AfterAgent).toHaveLength(2);
        expect(settings.hooks.BeforeAgent[0].hooks[0].command).toBe('node /app/out/agents/hook.cjs http://127.0.0.1:4100/hooks/BeforeAgent /data/agents/sessions/s1/token');
    });

    test('opencode gets its MCP server in OPENCODE_CONFIG_CONTENT and a status plugin in OPENCODE_CONFIG_DIR', () => {
        const started = launch(preset('opencode'), context);
        expect(JSON.parse(started.env.OPENCODE_CONFIG_CONTENT)).toEqual({ mcp: { appling: { type: 'remote', url: context.mcpUrl, headers: { Authorization: 'Bearer tok' }, oauth: false } } });
        expect(started.env.OPENCODE_CONFIG_DIR).toBe('/data/agents/sessions/s1/opencode');
        expect(started.files['/data/agents/sessions/s1/opencode/plugins/appling-status.js']).toBe(OPENCODE_PLUGIN);
        expect(OPENCODE_PLUGIN).toContain('session.idle');
    });

    test('custom presets come from settings.json, fill placeholders and may replace a built in one', () => {
        const { presets, problems } = agentPresets({
            'agents.presets': [
                { name: 'Aider', command: 'aider', args: ['--mcp', '{mcpUrl}', '--token={token}'], env: { AIDER_X: '1' } },
                { name: 'Claude Code', command: 'claude', args: ['--model', 'opus'], wiring: 'claude', answers: { deny: 'n' } },
                { name: 'Broken' },
                { name: 'Odd', command: 'x', wiring: 'telepathy' }
            ]
        });
        expect(problems).toEqual(['"agents.presets"[2] needs a "command"', '"agents.presets"[3]: "wiring" must be one of claude, codex, gemini, opencode, env']);
        expect(presets.map(p => p.name)).toEqual(['Claude Code', 'Codex', 'Gemini CLI', 'opencode', 'Aider']);
        expect(presets[0]).toMatchObject({ builtin: false, args: ['--model', 'opus'], answers: { allow: '\r', deny: 'n' } });
        const aider = launch(presets[4] as AgentPreset, context);
        expect(aider).toMatchObject({ command: 'aider', args: ['--mcp', context.mcpUrl, '--token=tok'], env: { AIDER_X: '1', APPLING_MCP_URL: context.mcpUrl }, files: {} });
        expect(agentPresets({ 'agents.presets': 3 }).problems).toEqual(['"agents.presets" must be a list of presets']);
    });

    test('answers become the agent\'s keys', () => {
        const keys = preset('Claude Code').answers;
        expect(answerKeys(keys, { kind: 'allow' })).toBe('\r');
        expect(answerKeys(keys, { kind: 'deny' })).toBe('\x1b');
        expect(answerKeys(keys, { kind: 'option', option: 2 })).toBe('2');
        expect(answerKeys(keys, { kind: 'reply', text: ' use the\nother one ' })).toBe('use the other one\r');
        expect(answerKeys(preset('Codex').answers, { kind: 'allow' })).toBe('y');
        expect([{ kind: 'allow' }, { kind: 'option', option: 3 }, { kind: 'reply', text: 'x' }].every(isAnswer)).toBe(true);
        expect([{ kind: 'option', option: 0 }, { kind: 'reply' }, { kind: 'run' }, null].some(isAnswer)).toBe(false);
    });
});

describe('status', () => {
    const at = new Date('2026-11-08T10:00:00Z');
    test('a session works, waits, is answered, finishes and exits', () => {
        let state: StatusState = { status: 'working' };
        state = reduce(state, { type: 'needs-input', kind: 'permission', message: 'Allow Bash?' }, at);
        expect(state).toEqual({ status: 'needs-input', note: 'Allow Bash?', prompt: { kind: 'permission', message: 'Allow Bash?', at: at.toISOString() } });
        // the turn does not end while the permission is open
        expect(reduce(state, { type: 'idle' })).toBe(state);
        state = reduce(state, { type: 'answered' });
        expect(state).toEqual({ status: 'working' });
        state = reduce(state, { type: 'idle', note: 'All done' });
        expect(state).toEqual({ status: 'done', note: 'All done' });
        expect(reduce(state, { type: 'failed', note: 'API error' })).toEqual({ status: 'failed', note: 'API error' });
        state = reduce(state, { type: 'exit', code: 2 });
        expect(state).toEqual({ status: 'exited', note: 'Exited with code 2' });
        expect(reduce(state, { type: 'working' })).toBe(state);
    });

    test('Enter, Escape or a digit answers a waiting agent; typing in a working one does not', () => {
        const waiting: StatusState = { status: 'needs-input', prompt: { kind: 'permission', message: '', at: '' } };
        expect(answers(waiting, '\r')).toBe(true);
        expect(answers(waiting, '\x1b')).toBe(true);
        expect(answers(waiting, '2')).toBe(true);
        expect(answers(waiting, '\x1b[A')).toBe(false);
        expect(answers({ status: 'working' }, '\r')).toBe(false);
        expect(answers({ status: 'done' }, 'next task\r')).toBe(true);
    });

    test('hook events of Claude Code, Gemini CLI and opencode', () => {
        expect(hookSignal('claude', 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm test\nmore' } })).toEqual({ type: 'needs-input', kind: 'permission', message: 'Allow Bash: npm test?' });
        expect(hookSignal('claude', 'Notification', { notification_type: 'idle_prompt' })).toEqual({ type: 'idle' });
        expect(hookSignal('claude', 'Notification', { notification_type: 'elicitation_dialog', message: 'Pick one' })).toEqual({ type: 'needs-input', kind: 'question', message: 'Pick one' });
        expect(hookSignal('claude', 'Notification', { notification_type: 'auth_success' })).toBeUndefined();
        expect(hookSignal('claude', 'Stop', { last_assistant_message: '\nDone with it.\nDetails' })).toEqual({ type: 'idle', note: 'Done with it.' });
        expect(hookSignal('claude', 'StopFailure', { error: 'rate_limit' })).toEqual({ type: 'failed', note: 'rate_limit' });
        expect(hookSignal('claude', 'UserPromptSubmit', {})).toEqual({ type: 'working' });
        expect(hookSignal('gemini', 'Notification', { notification_type: 'ToolPermission', message: 'Run shell?' })).toEqual({ type: 'needs-input', kind: 'permission', message: 'Run shell?' });
        expect(hookSignal('gemini', 'AfterAgent', {})).toEqual({ type: 'idle' });
        expect(hookSignal('opencode', 'permission.asked', { title: 'Edit file' })).toEqual({ type: 'needs-input', kind: 'permission', message: 'Edit file' });
        expect(hookSignal('opencode', 'session.idle', {})).toEqual({ type: 'idle' });
        expect(hookSignal('codex', 'Stop', {})).toBeUndefined();
    });

    test('terminal notifications: Codex approvals and finished turns, any other agent waiting', () => {
        expect(notificationSignal('codex', { body: 'Approval requested: rm -rf x', source: 'osc9' })).toMatchObject({ type: 'needs-input', kind: 'permission' });
        expect(notificationSignal('codex', { body: 'Question: which one?', source: 'osc9' })).toMatchObject({ type: 'needs-input', kind: 'question' });
        expect(notificationSignal('codex', { body: 'I fixed the tests.', source: 'osc9' })).toEqual({ type: 'idle', note: 'I fixed the tests.' });
        expect(notificationSignal('claude', { body: 'Claude needs you', source: 'osc9' })).toBeUndefined();
        expect(notificationSignal('env', { title: 'Aider', body: 'Confirm?', source: 'osc777' })).toEqual({ type: 'needs-input', kind: 'input', message: 'Aider: Confirm?' });
    });
});

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

function post(url: string, headers: Record<string, string>, body = '{}'): Promise<{ status: number, text: string }> {
    return new Promise((resolve, reject) => {
        const req = request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, res => {
            let text = '';
            res.on('data', chunk => text += chunk);
            res.on('end', () => resolve({ status: res.statusCode!, text }));
        });
        req.on('error', reject);
        req.end(body);
    });
}

/** Runs the built hook client with stdin, without blocking the gateway in this process. */
function run(args: string[], input: string): Promise<{ status: number | null, stdout: string }> {
    return new Promise(resolve => {
        const child = spawn(process.execPath, [join(import.meta.dirname, '../out/agents/hook.cjs'), ...args]);
        let stdout = '';
        child.stdout.on('data', chunk => stdout += chunk);
        child.on('close', status => resolve({ status, stdout }));
        child.stdin.end(input);
    });
}

describe('gateway', () => {
    test('takes hook events with a session token and refuses unknown tokens, hosts and browsers', async () => {
        const hooks: unknown[] = [];
        const gateway = new Gateway({ authenticate: async token => token === 'good' ? 's1' : undefined, target: () => undefined, onHook: (...args) => hooks.push(args) });
        const port = await gateway.listen();
        try {
            expect((await post(`${gateway.hookUrl}/Stop`, { authorization: 'Bearer good' }, '{"last_assistant_message":"ok"}')).status).toBe(200);
            expect(hooks).toEqual([['s1', 'Stop', { last_assistant_message: 'ok' }]]);
            expect((await post(`${gateway.hookUrl}/Stop`, { authorization: 'Bearer bad' })).status).toBe(401);
            expect((await post(`${gateway.hookUrl}/Stop`, {})).status).toBe(401);
            expect((await post(`${gateway.hookUrl}/Stop`, { authorization: 'Bearer good', origin: 'https://evil.example' })).status).toBe(403);
            expect((await post(`${gateway.hookUrl}/Stop`, { authorization: 'Bearer good', host: `evil.example:${port}` })).status).toBe(403);
            expect((await post(gateway.mcpUrl, { authorization: 'Bearer good' })).status).toBe(503);
            // the next start takes the same port, or another one when it is taken
            const second = new Gateway({ authenticate: async () => undefined, target: () => undefined, onHook: () => undefined });
            expect(await second.listen(port)).not.toBe(port);
            second.close();
        } finally {
            gateway.close();
        }
        expect(hooks).toHaveLength(1);
    });

    test('the command hook client posts its stdin with the token from its file', async () => {
        const hooks: unknown[] = [];
        const gateway = new Gateway({ authenticate: async token => token === 'good' ? 's1' : undefined, target: () => undefined, onHook: (...args) => hooks.push(args) });
        await gateway.listen();
        const dir = temp('agents-hook-');
        writeFileSync(join(dir, 'token'), 'good\n');
        try {
            expect(await run([`${gateway.hookUrl}/AfterAgent`, join(dir, 'token')], '{"prompt_response":"ok"}')).toEqual({ status: 0, stdout: '' });
            expect(hooks).toEqual([['s1', 'AfterAgent', { prompt_response: 'ok' }]]);
            // an unreachable gateway still ends cleanly, so the agent goes on
            expect((await run(['http://127.0.0.1:9/hooks/x', join(dir, 'token')], '{}')).status).toBe(0);
        } finally {
            gateway.close();
        }
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
});

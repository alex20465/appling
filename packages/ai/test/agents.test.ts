import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { agentPresets, answerKeys, answers, BUILTIN_PRESETS, CLAUDE_HOOKS, Gateway, hookSignal, isAnswer, launch, notificationSignal, OPENCODE_PLUGIN, reduce, type AgentPreset, type LaunchContext, type StatusState } from '../src/agents/index.js';

const temps: string[] = [];
function temp(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    temps.push(dir);
    return dir;
}
afterAll(() => temps.forEach(dir => rmSync(dir, { recursive: true, force: true })));

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
            expect((await post(`${gateway.hookUrl}/Stop`, { authorization: 'Bearer good', host: '127.0.0.1:47123' })).status).toBe(403);
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

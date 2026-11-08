import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { MemorySessionStore } from '@appling/ai';
import { connectPtyHost } from '@appling/pty-host';
import { agentPresets } from '@appling/ai/agents';
import { AgentSessions } from '../src/agents/sessions.js';
import { remoteAgentHost } from '../src/remote/agents.js';
import type { ConnectionState } from '../src/remote/connection.js';
import { codeServerAsset } from '../src/code-download.js';
import { RemoteRepo } from '../src/remote/remote-repo.js';
import { TrayRemotes } from '../src/remote/tray-remotes.js';
import type { NotifyRequest } from '@appling/pty-host';
import { shellQuote } from '../src/remote/transport.js';
import { TaskRunner } from '../src/tasks/runner.js';
import { remoteTasks, remoteTerminals } from '../src/tasks/remote.js';
import { TerminalService } from '../src/terminal/service.js';
import { DEFAULT_TERMINAL_SETTINGS } from '../src/terminal/settings.js';

/**
 * The remote side for real: an sshd of this user on a free port (no root needed) and a container, each reached through
 * the transport, with the server bundle installed there by `install.ts`. Skipped where sshd or docker is missing.
 */
const SSHD = ['/usr/sbin/sshd', '/usr/bin/sshd'].find(existsSync);
const has = (command: string, args: string[]) => spawnSync(command, args, { stdio: 'ignore' }).status === 0;
const exists = (command: string) => !spawnSync(command, ['-?'], { stdio: 'ignore' }).error;
const SSH = !!SSHD && exists('ssh') && exists('ssh-keygen');
const DOCKER = has('docker', ['info']);
const MODEL = 'module shop {\n    entity Order {\n        total: Int\n    }\n}\n';

const root = mkdtempSync(join(tmpdir(), 'appling-rmt-'));
let app = '';
afterAll(() => rmSync(root, { recursive: true, force: true }));

beforeAll(() => {
    if (!SSH && !DOCKER) return;
    app = join(root, 'app');
    execFileSync(process.execPath, [join(import.meta.dirname, '../scripts/bundle.mjs'), '--out', app], { stdio: 'ignore' });
}, 240000);

function freePort(): Promise<number> {
    return new Promise(resolve => {
        const server = createServer().listen(0, '127.0.0.1', () => {
            const { port } = server.address() as { port: number };
            server.close(() => resolve(port));
        });
    });
}

function repoFolder(name: string, text = MODEL): string {
    const folder = join(root, name);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'shop.appling'), text);
    return folder;
}

/** Fetches a URL on the other side, with the Node binary installed there. */
async function fetchThere(repo: RemoteRepo, url: string): Promise<string> {
    const script = `fetch(${JSON.stringify(url)}, { method: 'POST', body: 'there' }).then(r => r.text()).then(t => console.log(t), e => { console.error(e.message); process.exit(1); })`;
    const result = await repo.transport.exec(`${shellQuote(repo.installed!.agent.node)} -e ${shellQuote(script)}`, { timeout: 20000 });
    expect(result.stderr).toBe('');
    return result.stdout.trim();
}

/** An HTTP server here that tells what reached it: a stand-in for the agent gateway or the code bridge. */
async function echoServer(): Promise<{ port: number, close(): void }> {
    const { createServer: createHttp } = await import('node:http');
    const server = createHttp((req, res) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => res.end(`here ${req.url} ${body}`));
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    return { port: (server.address() as { port: number }).port, close: () => server.close() };
}

const FAKE = join(import.meta.dirname, 'fixtures/fake-agent.mjs');

async function until<T>(check: () => T | undefined | false, debug?: () => string, timeout = 30000): Promise<T> {
    const deadline = Date.now() + timeout;
    for (;;) {
        const value = check();
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`Timed out.${debug ? `\n${debug()}` : ''}`);
        await new Promise(done => setTimeout(done, 50));
    }
}

async function snapshot(url: string): Promise<{ files: { path?: string, uri?: string }[], errors: unknown[] }> {
    const response = await fetch(`${url}/api/snapshot`);
    expect(response.status).toBe(200);
    return response.json() as never;
}

describe.skipIf(!SSH)('over ssh', () => {
    const dir = join(root, 'ssh');
    let sshd: ChildProcess;
    let port = 0;
    let repo: RemoteRepo;
    const states: ConnectionState[] = [];
    const progress: string[] = [];
    let connects = 0;
    /** The shared agent sessions, as the app keeps them, served to the IDE server there. */
    const store = new MemorySessionStore();
    const reversed: [string, number][] = [];

    beforeAll(async () => {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'host')]);
        execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'id')]);
        copyFileSync(join(dir, 'id.pub'), join(dir, 'authorized_keys'));
        chmodSync(join(dir, 'authorized_keys'), 0o600);
        port = await freePort();
        // the remote side's install and pty host go to this test's folders, not the user's
        writeFileSync(join(dir, 'sshd_config'), [
            `Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${join(dir, 'host')}`, `PidFile ${join(dir, 'sshd.pid')}`,
            `AuthorizedKeysFile ${join(dir, 'authorized_keys')}`, 'UsePAM no', 'StrictModes no', 'PasswordAuthentication no',
            'KbdInteractiveAuthentication no', 'PubkeyAuthentication yes',
            `SetEnv APPLING_SERVER_ROOT=${join(dir, 'server')} APPLING_PTY_HOST_DIR=${join(dir, 'remote-pty')}`
        ].join('\n'));
        sshd = spawn(SSHD!, ['-D', '-f', join(dir, 'sshd_config'), '-E', join(dir, 'sshd.log')], { stdio: 'ignore' });
        await vi.waitFor(() => expect(readFileSync(join(dir, 'sshd.log'), 'utf8')).toMatch(/Server listening/), { timeout: 10000 });
        repo = new RemoteRepo({
            location: { kind: 'ssh', host: '127.0.0.1', port, user: userInfo().username, path: repoFolder('ssh-repo') },
            transportOptions: {
                ssh: {
                    args: ['-F', '/dev/null', '-i', join(dir, 'id'), '-o', 'IdentitiesOnly=yes', '-o', `UserKnownHostsFile=${join(dir, 'known_hosts')}`],
                    controlDir: join(dir, 'ctl'),
                    keepAlive: 2
                }
            },
            install: { app, cache: join(dir, 'cache'), node: process.execPath },
            ide: { sessions: store },
            ptyDir: join(dir, 'local-pty'),
            backoff: { initial: 200, factor: 2, max: 2000, attempts: 10 },
            onState: state => states.push(state),
            onProgress: line => progress.push(line),
            onConnected: () => connects++,
            onReverse: (name, port) => reversed.push([name, port])
        });
    }, 30000);

    afterAll(async () => {
        await repo?.close();
        sshd?.kill();
        // the "remote" pty host runs on this machine: stop it directly
        if (app) spawnSync(process.execPath, [join(app, 'pty-host/out/main.js'), 'stop', '--dir', join(dir, 'remote-pty')], { stdio: 'ignore' });
    });

    test('installs the server, starts the IDE there and serves it on a local port', async () => {
        await repo.start();
        expect(repo.connection.error).toBeUndefined();
        expect(repo.connection.state).toBe('connected');
        expect(progress.some(line => line.startsWith('Installing the Appling server'))).toBe(true);
        expect(existsSync(join(dir, 'server', repo.installed!.version, '.installed'))).toBe(true);
        expect(repo.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        const first = await snapshot(repo.url!);
        expect(JSON.stringify(first.files)).toContain('shop.appling');
        expect(repo.terminalsProblem).toBeUndefined();
    }, 120000);

    test('terminals run in the remote pty host and survive a network drop, then reattach', async () => {
        const url = repo.url;
        const client = await connectPtyHost({ dir: join(dir, 'local-pty'), start: false });
        const terminal = await client.spawn({ shell: '/bin/sh', args: ['-c', 'echo before-drop; exec sleep 600'], cwd: repo.root, group: 'test' });
        const attached = await client.attach(terminal.id);
        let output = '';
        attached.onData(data => output += data);
        await vi.waitFor(() => expect(output + attached.scrollback).toContain('before-drop'), { timeout: 10000 });

        // the network goes: the ssh master dies without a goodbye
        const master = (repo.transport as unknown as { master: ChildProcess }).master;
        master.kill('SIGKILL');
        await vi.waitFor(() => expect(states).toContain('reconnecting'), { timeout: 10000 });
        await vi.waitFor(() => expect(repo.connection.state).toBe('connected'), { timeout: 60000 });
        expect(connects).toBe(2);
        // the view keeps its URL; the new server answers there
        expect(repo.url).toBe(url);
        expect(JSON.stringify((await snapshot(repo.url!)).files)).toContain('shop.appling');

        const again = await connectPtyHost({ dir: join(dir, 'local-pty'), start: false });
        expect((await again.list('test')).map(t => t.id)).toContain(terminal.id);
        const reattached = await again.attach(terminal.id);
        expect(reattached.scrollback).toContain('before-drop');
        await again.kill(terminal.id);
        again.close();
        client.close();
    }, 120000);

    test('a reconnect finds the install and skips it', async () => {
        progress.length = 0;
        (repo.transport as unknown as { master: ChildProcess }).master.kill('SIGKILL');
        await vi.waitFor(() => expect(connects).toBe(3), { timeout: 60000 });
        expect(repo.connection.state).toBe('connected');
        expect(progress.some(line => line.startsWith('Connecting'))).toBe(true);
        expect(progress.some(line => line.startsWith('Installing'))).toBe(false);
    }, 90000);

    test('tasks read tasks.json over the transport and run in the remote pty host, the built in appling check too', async () => {
        const id = `ssh://127.0.0.1/${repo.root}`;
        mkdirSync(join(repo.root!, '.vscode'), { recursive: true });
        writeFileSync(join(repo.root!, '.vscode', 'tasks.json'), JSON.stringify({
            version: '2.0.0',
            tasks: [{ label: 'where', type: 'shell', command: 'echo "$(pwd) ${env:HOME} $WHO" > where.txt', options: { env: { WHO: 'remote' } } }]
        }));
        const service = new TerminalService({
            host: { dir: join(dir, 'unused-local-pty'), start: false },
            settings: () => DEFAULT_TERMINAL_SETTINGS,
            remote: () => remoteTerminals(repo, id, join(dir, 'local-pty'))
        });
        const runner = new TaskRunner(service, { platform: 'linux', remote: () => remoteTasks(repo, id) });
        await runner.openRepo(id);
        expect(runner.list(id).map(task => task.label)).toEqual(['where', 'appling: check', 'appling: generate', 'appling: release']);
        expect(await runner.run(id, 'where')).toMatchObject({ status: 'succeeded' });
        expect(readFileSync(join(repo.root!, 'where.txt'), 'utf8').trim()).toBe(`${repo.root} ${repo.installed!.probe.home} remote`);
        const terminal = runner.state(id, 'where').terminal!;
        const client = await connectPtyHost({ dir: join(dir, 'local-pty'), start: false });
        expect((await client.list(id)).map(t => t.id)).toContain(terminal);
        client.close();
        // the command line of the server bundle there
        expect(await runner.run(id, 'appling: check')).toMatchObject({ status: 'succeeded', exit: { code: 0 } });
        await service.closeRepo(id);
        service.dispose();
    }, 90000);

    test('a reverse forward over the ssh master reaches a port here from there, and comes back on its port after a drop', async () => {
        const server = await echoServer();
        const port = await repo.reverse('code-bridge', server.port);
        expect(port).not.toBe(server.port);
        expect(await repo.reverse('code-bridge', server.port)).toBe(port);
        expect(await fetchThere(repo, `http://127.0.0.1:${port}/bridge`)).toBe('here /bridge there');
        const before = connects;
        (repo.transport as unknown as { master: ChildProcess }).master.kill('SIGKILL');
        await vi.waitFor(() => expect(connects).toBe(before + 1), { timeout: 60000 });
        const after = repo.reversePort('code-bridge')!;
        // the same port there, unless sshd still held it (then the move is reported)
        if (after !== port) expect(reversed).toContainEqual(['code-bridge', after]);
        expect(await fetchThere(repo, `http://127.0.0.1:${after}/again`)).toBe('here /again there');
        server.close();
    }, 90000);

    test('Code OSS there gets the code bridge\'s URL there and its token over stdin, and reaches the bridge here', async () => {
        // a stand-in for openvscode-server, already installed there: it serves its environment
        const asset = codeServerAsset('linux', process.arch)!;
        const bin = join(dir, 'server', 'code', asset.name, 'bin');
        mkdirSync(bin, { recursive: true });
        writeFileSync(join(bin, 'openvscode-server'), [
            `#!${process.execPath}`,
            "if (process.argv.includes('--install-extension')) process.exit(0);",
            "const server = require('node:http').createServer((req, res) => res.end(JSON.stringify({ bridge: process.env.APPLING_DESKTOP_BRIDGE, token: process.env.APPLING_DESKTOP_TOKEN, argv: process.argv.join(' ') })));",
            "server.listen(0, '127.0.0.1', () => console.log(`Server bound to 127.0.0.1:${server.address().port} (IPv4)`));"
        ].join('\n'), { mode: 0o755 });
        const bridge = await echoServer();
        const port = await repo.reverse('code-bridge', bridge.port);
        const code = await repo.startCode('k1', { APPLING_DESKTOP_BRIDGE: `ws://127.0.0.1:${port}/bridge`, APPLING_DESKTOP_TOKEN: 'secret-token' });
        const seen = await (await fetch(`http://127.0.0.1:${code.port}/`)).json() as { bridge: string, token: string, argv: string };
        expect(seen).toMatchObject({ bridge: `ws://127.0.0.1:${port}/bridge`, token: 'secret-token' });
        // the token went over stdin, never into a command line there
        expect(seen.argv).not.toContain('secret-token');
        expect(await fetchThere(repo, seen.bridge.replace('ws:', 'http:'))).toBe('here /bridge there');
        await code.close();
        bridge.close();
    }, 90000);

    test('an agent session in the ssh repo runs there and reaches MCP and its hooks through the gateway\'s reverse forward', async () => {
        const id = `ssh://127.0.0.1/${repo.root}`;
        const service = new TerminalService({
            host: { dir: join(dir, 'unused-local-pty'), start: false },
            settings: () => DEFAULT_TERMINAL_SETTINGS,
            remote: () => remoteTerminals(repo, id, join(dir, 'local-pty'))
        });
        let output = '';
        service.on('data', (_, chunk) => output += chunk);
        const agents = new AgentSessions({
            store, terminals: service, folder: join(dir, 'local-agents'),
            ideMcp: () => repo.ide?.mcp,
            presets: () => agentPresets({ 'agents.presets': [{ name: 'Fake Claude', command: process.execPath, args: [FAKE], wiring: 'claude' }] }).presets,
            remote: () => remoteAgentHost(repo)
        });
        await agents.start();
        const record = await agents.create(id, 'Fake Claude');
        // the configuration files are on that machine, next to its server install, and only its user reads them
        expect(record.remote!.dir).toBe(join(dir, 'server', 'agent-sessions', record.id));
        expect(statSync(join(record.remote!.dir, 'mcp.json')).mode & 0o777).toBe(0o600);
        expect(statSync(record.remote!.dir).mode & 0o777).toBe(0o700);
        expect(JSON.parse(readFileSync(join(record.remote!.dir, 'mcp.json'), 'utf8')).mcpServers.appling.url).toBe(`http://127.0.0.1:${record.remote!.port}/mcp`);
        expect(record.remote!.port).not.toBe(agents.gateway.port);
        expect(existsSync(join(dir, 'local-agents', 'sessions', record.id))).toBe(false);
        // the command hook client of Gemini CLI style agents is part of the server bundle there
        expect(existsSync(join(dir, 'server', repo.installed!.version, 'remote', 'hook.cjs'))).toBe(true);

        // MCP (label, claims) and the PermissionRequest hook, both through the forward there
        await until(() => agents.get(record.id)?.status === 'needs-input', () => output);
        expect(agents.get(record.id)).toMatchObject({ label: 'Fake work', claims: { elements: ['sales.Order'] } });
        // the MCP session works in the repo's folder there; the Desktop record keeps the repo id
        expect(await store.get(record.id)).toMatchObject({ label: 'Fake work', repo: repo.root });
        expect(record.repo).toBe(id);

        // the network drops; after the reconnect the terminals attach again and the gateway is reachable there again
        const before = connects;
        (repo.transport as unknown as { master: ChildProcess }).master.kill('SIGKILL');
        await vi.waitFor(() => expect(connects).toBe(before + 1), { timeout: 60000 });
        await service.reconnectRepo(id);
        await agents.remoteConnected(id);
        if (agents.get(record.id)!.remote!.port !== record.remote!.port) {
            // it moved: the files there name the new port
            expect(JSON.parse(readFileSync(join(record.remote!.dir, 'settings.json'), 'utf8')).hooks.Stop[0].hooks[0].url).toContain(`:${agents.get(record.id)!.remote!.port}/`);
        }

        expect(agents.get(record.id)).toMatchObject({ status: 'needs-input' });
        expect(agents.answer(record.id, { kind: 'allow' })).toBe(true);
        await until(() => agents.get(record.id)?.status === 'done', () => output);
        expect(agents.get(record.id)).toMatchObject({ note: 'All done' });
        agents.answer(record.id, { kind: 'reply', text: 'thanks' });
        await until(() => agents.get(record.id)?.status === 'exited', () => output);
        expect(output).toContain('reply:"thanks"');
        // the token and the files there go with the agent
        await until(() => !existsSync(record.remote!.dir));
        await agents.close(record.id);
        agents.dispose();
        service.dispose();
    }, 120000);

    test('while the app is closed the tray follows the remote pty host over ssh: lists, notifies, replies and stops (#18)', async () => {
        const id = `ssh://${userInfo().username}@127.0.0.1:${port}${repo.root}`;
        const notified: NotifyRequest[] = [];
        const opened: string[] = [];
        let changes = 0;
        const tray = new TrayRemotes({
            userData: join(dir, 'tray'),
            app: () => app,
            notifier: { notify: async request => (notified.push(request), { action: 'reply', text: 'yes' }) },
            open: (repo, terminal) => opened.push(`${repo} ${terminal}`),
            onChange: () => changes++,
            repo: {
                transportOptions: {
                    ssh: {
                        args: ['-F', '/dev/null', '-i', join(dir, 'id'), '-o', 'IdentitiesOnly=yes', '-o', `UserKnownHostsFile=${join(dir, 'known_hosts')}`],
                        controlDir: join(dir, 'tray-ctl'),
                        keepAlive: 2
                    }
                },
                install: { app, cache: join(dir, 'cache'), node: process.execPath },
                backoff: { initial: 200, factor: 2, max: 2000, attempts: 10 }
            }
        });
        // an agent that waits for an answer, started by the app before it closed; nobody is attached to it now
        const app_ = await connectPtyHost({ dir: join(dir, 'local-pty'), start: false });
        const ask = ['-c', 'printf "\\033]9;Approve?\\007"; read a; echo "got-$a"; [ "$a" = yes ] && exec sleep 600; exit 5'];
        const waiting = await app_.spawn({ shell: '/bin/sh', args: ask, cwd: repo.root, group: repo.root, meta: { label: 'Plan' } });
        app_.close();
        try {
            tray.follow([id]);
            expect(tray.followed()).toEqual([id]);
            // the tray connects only to the pty host there, raises the wait here and the reply reaches the pty
            await until(() => notified.length > 0, () => JSON.stringify(tray.terminals()), 60000);
            expect(notified[0]).toMatchObject({ terminal: waiting.id, title: 'Plan · ssh-repo', body: 'Approve?' });
            await until(() => tray.terminals()[0]?.terminals.find(t => t.id === waiting.id)?.status.state === 'running', () => JSON.stringify(tray.terminals()));
            expect(changes).toBeGreaterThan(0);
            const check = await connectPtyHost({ dir: join(dir, 'local-pty'), start: false });
            expect((await check.attach(waiting.id)).scrollback).toContain('got-yes');
            check.close();
            // listed with the repo, and stopped from the tray
            expect(tray.terminals().map(r => r.repo)).toEqual([id]);
            await tray.stopAll();
            await until(() => !tray.terminals()[0]?.terminals.some(t => t.id === waiting.id && t.status.state !== 'exited'), () => JSON.stringify(tray.terminals()));
            // the app opens again: the tray lets go of the repo
            tray.follow([]);
            expect(tray.followed()).toEqual([]);
            expect(tray.terminals()).toEqual([]);
        } finally {
            await tray.close();
            const cleanup = await connectPtyHost({ dir: join(dir, 'local-pty'), start: false }).catch(() => undefined);
            await cleanup?.kill(waiting.id).catch(() => undefined);
            cleanup?.close();
        }
    }, 120000);

    test('after the ssh master dies, terminals and task terminals attach again and take input', async () => {
        const id = `ssh://127.0.0.1/${repo.root}`;
        writeFileSync(join(repo.root!, '.vscode', 'tasks.json'), JSON.stringify({
            version: '2.0.0',
            tasks: [{ label: 'ask', type: 'shell', command: 'echo task-started; read line; echo "$line" > answer.txt' }]
        }));
        const service = new TerminalService({
            host: { dir: join(dir, 'unused-local-pty'), start: false },
            settings: () => DEFAULT_TERMINAL_SETTINGS,
            remote: () => remoteTerminals(repo, id, join(dir, 'local-pty'))
        });
        const output = new Map<string, string>();
        service.on('data', (terminal, chunk) => output.set(terminal, (output.get(terminal) ?? '') + chunk));
        const attached = new Map<string, string>();
        service.on('attached', (terminal, scrollback) => attached.set(terminal, scrollback));
        const reconnected: string[] = [];
        service.on('reconnected', repo => reconnected.push(repo));
        const runner = new TaskRunner(service, { platform: 'linux', remote: () => remoteTasks(repo, id) });
        await runner.openRepo(id);
        const shell = await service.create(id, { command: '/bin/sh', args: ['-c', 'echo before-drop; while read line; do echo "got:$line"; done'] });
        await until(() => output.get(shell.id)?.includes('before-drop'));
        const run = runner.run(id, 'ask');
        const task = await until(() => runner.state(id, 'ask').terminal);
        await until(() => output.get(task)?.includes('task-started'));

        const before = connects;
        (repo.transport as unknown as { master: ChildProcess }).master.kill('SIGKILL');
        await vi.waitFor(() => expect(connects).toBe(before + 1), { timeout: 60000 });
        // what the app does on a reconnect (`launchRemote`)
        await service.reconnectRepo(id);
        expect(reconnected).toEqual([id]);
        expect(attached.get(shell.id)).toContain('before-drop');
        expect(attached.get(task)).toContain('task-started');
        expect(service.registry.terminals(id)).toEqual(expect.arrayContaining([shell.id, task]));

        service.write(shell.id, 'after-drop\r');
        await until(() => output.get(shell.id)?.includes('got:after-drop'), () => output.get(shell.id) ?? '');
        service.write(task, 'answered\r');
        expect(await run).toMatchObject({ status: 'succeeded' });
        expect(readFileSync(join(repo.root!, 'answer.txt'), 'utf8').trim()).toBe('answered');
        await service.closeRepo(id);
        service.dispose();
    }, 120000);
});

const IMAGE = process.env.APPLING_TEST_IMAGE ?? 'debian:bookworm-slim';

describe.skipIf(!DOCKER)('in a dev container', () => {
    let repo: RemoteRepo;
    let folder = '';

    beforeAll(() => {
        if (!has('docker', ['image', 'inspect', IMAGE])) execFileSync('docker', ['pull', '-q', IMAGE], { stdio: 'ignore' });
        folder = repoFolder('container-repo');
        mkdirSync(join(folder, '.devcontainer'));
        writeFileSync(join(folder, '.devcontainer', 'devcontainer.json'), `{ // the test's container\n "image": "${IMAGE}", "containerEnv": { "APPLING_TEST": "1" } }`);
    }, 240000);

    afterAll(async () => {
        await repo?.close();
        const ids = execFileSync('docker', ['ps', '-a', '-q', '--filter', `label=devcontainer.local_folder=${folder}`], { encoding: 'utf8' }).split('\n').filter(Boolean);
        if (ids.length) execFileSync('docker', ['rm', '-f', ...ids], { stdio: 'ignore' });
    });

    test('runs the container from devcontainer.json, installs over docker exec and serves the IDE', async () => {
        repo = new RemoteRepo({
            location: { kind: 'container', folder },
            container: { devcontainer: join(root, 'no-devcontainer-cli') },
            install: { app, cache: join(root, 'container-cache'), node: process.execPath },
            ptyDir: join(root, 'container-pty')
        });
        await repo.start();
        expect(repo.connection.error).toBeUndefined();
        expect(repo.connection.state).toBe('connected');
        expect(repo.root).toBe('/workspaces/container-repo');
        const files = JSON.stringify((await snapshot(repo.url!)).files);
        expect(files).toContain('shop.appling');
        expect(repo.terminalsProblem).toBeUndefined();
        const client = await connectPtyHost({ dir: join(root, 'container-pty'), start: false });
        const terminal = await client.spawn({ shell: '/bin/sh', args: ['-c', 'echo in-container $APPLING_TEST; exec sleep 600'], cwd: repo.root!, env: { PATH: '/usr/bin:/bin', APPLING_TEST: '1' } });
        const attached = await client.attach(terminal.id);
        let output = '';
        attached.onData(data => output += data);
        await vi.waitFor(() => expect(output + attached.scrollback).toContain('in-container 1'), { timeout: 10000 });
        client.close();
        // a stopped container is a lost connection; it is started again
        const container = (repo.transport as unknown as { container: string }).container;
        execFileSync('docker', ['stop', '-t', '1', container], { stdio: 'ignore' });
        await vi.waitFor(() => expect(repo.connection.state).not.toBe('connected'), { timeout: 30000 });
        await vi.waitFor(() => expect(repo.connection.state).toBe('connected'), { timeout: 90000 });
        expect(JSON.stringify((await snapshot(repo.url!)).files)).toContain('shop.appling');
    }, 240000);

    test('a reverse forward through the agent\'s stdio reaches a port here from the container, again after it restarted', async () => {
        const server = await echoServer();
        const port = await repo.reverse('agents', server.port);
        expect(await fetchThere(repo, `http://127.0.0.1:${port}/mcp`)).toBe('here /mcp there');
        const container = (repo.transport as unknown as { container: string }).container;
        execFileSync('docker', ['restart', '-t', '1', container], { stdio: 'ignore' });
        await vi.waitFor(() => expect(repo.connection.state).not.toBe('connected'), { timeout: 30000 });
        await vi.waitFor(() => expect(repo.connection.state).toBe('connected'), { timeout: 90000 });
        await vi.waitFor(() => expect(repo.reversePort('agents')).toBeDefined(), { timeout: 10000 });
        // the container came back empty of listeners: the same port there
        expect(repo.reversePort('agents')).toBe(port);
        expect(await fetchThere(repo, `http://127.0.0.1:${port}/hooks/Stop`)).toBe('here /hooks/Stop there');
        server.close();
    }, 180000);
});

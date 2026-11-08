import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, test } from 'vitest';
import { connectPtyHost, hostMain, PtyHostClient, type AttachedTerminal } from '../src/index.js';
import { ensureDir, socketPath, tokenPath } from '../src/paths.js';
import { answers } from '../src/protocol.js';

const run = promisify(execFile);
const SH = { shell: '/bin/sh', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', PS1: '$ ', HOME: tmpdir() } };
const dirs: string[] = [];

/** A fresh host folder; Unix socket paths are limited to about 100 characters, so it lives in the system temp. */
function hostDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'pty-'));
    dirs.push(dir);
    return dir;
}

afterAll(async () => {
    for (const dir of dirs) {
        const client = await PtyHostClient.connect(dir).catch(() => undefined);
        await client?.shutdown().catch(() => undefined);
        await until(async () => !await answers(socketPath(dir)));
        rmSync(dir, { recursive: true, force: true });
    }
});

async function until(check: () => boolean | Promise<boolean>, timeout = 5000): Promise<void> {
    const deadline = Date.now() + timeout;
    while (!await check()) {
        if (Date.now() > deadline) throw new Error('Timed out.');
        await new Promise(done => setTimeout(done, 25));
    }
}

/** Collects a terminal's live output. */
function output(terminal: AttachedTerminal): { text: () => string } {
    let text = '';
    terminal.onData(data => text += data);
    return { text: () => text };
}

describe.skipIf(process.platform === 'win32')('pty host', () => {
    test('a terminal keeps running after its client disconnects and replays its scrollback on reattach', async () => {
        const dir = hostDir();
        const first = await connectPtyHost({ dir });
        expect(statSync(dir).mode & 0o777).toBe(0o700);
        expect(statSync(socketPath(dir)).mode & 0o777).toBe(0o600);
        expect(statSync(tokenPath(dir)).mode & 0o777).toBe(0o600);
        const info = await first.spawn({ ...SH, cwd: dir, group: 'shop', title: 'build' });
        expect(info).toMatchObject({ group: 'shop', title: 'build', cwd: dir, cols: 80, rows: 24 });
        const terminal = await first.attach(info.id);
        const live = output(terminal);
        terminal.write('echo one-$((1+1))\r');
        await until(() => live.text().includes('one-2'));
        first.close();
        await new Promise(done => first.once('close', done));

        const second = await connectPtyHost({ dir, start: false });
        expect(second.host.pid).toBe(first.host.pid);
        const [listed] = await second.list('shop');
        expect(listed).toMatchObject({ id: info.id, attached: 0 });
        expect(await second.list('crm')).toEqual([]);
        const again = await second.attach(info.id, { cols: 100, rows: 30 });
        expect(again.scrollback).toContain('one-2');
        expect(again.info).toMatchObject({ cols: 100, rows: 30, attached: 1 });
        const more = output(again);
        again.write('stty size; echo two-$((2+2))\r');
        await until(() => more.text().includes('two-4'));
        expect(more.text()).toContain('30 100');
        second.close();
    }, 20000);

    test('the host outlives the process that started it', async () => {
        const dir = hostDir();
        const script = `
            import { connectPtyHost } from ${JSON.stringify(new URL('../out/index.js', import.meta.url).href)};
            const client = await connectPtyHost({ dir: ${JSON.stringify(dir)} });
            const info = await client.spawn({ ...${JSON.stringify(SH)}, cwd: ${JSON.stringify(dir)} });
            const terminal = await client.attach(info.id);
            terminal.onData(data => data.includes('from-0child') && process.exit(0));
            terminal.write('echo from-$((0))child\\r');
        `;
        await run(process.execPath, ['--input-type=module', '-e', script], { timeout: 15000 });
        const client = await connectPtyHost({ dir, start: false });
        expect(client.host.pid).not.toBe(process.pid);
        const [info] = await client.list();
        const terminal = await client.attach(info.id);
        expect(terminal.scrollback).toContain('from-0child');
        client.close();
    }, 20000);

    test('a terminal that ends keeps its scrollback until it is killed', async () => {
        const dir = hostDir();
        const client = await connectPtyHost({ dir });
        const info = await client.spawn({ ...SH, args: ['-c', 'echo bye; sleep 0.3; exit 3'], cwd: dir });
        const terminal = await client.attach(info.id);
        const exit = await new Promise(done => terminal.onExit(done));
        expect(exit).toMatchObject({ code: 3 });
        await terminal.detach();
        const [ended] = await client.list();
        expect(ended.exit).toMatchObject({ code: 3 });
        const replay = await client.attach(info.id);
        expect(replay.scrollback).toContain('bye');
        expect(await new Promise(done => replay.onExit(done))).toMatchObject({ code: 3 });
        await client.kill(info.id);
        expect(await client.list()).toEqual([]);
        await expect(client.attach(info.id)).rejects.toThrow(/No terminal/);
        client.close();
    }, 20000);

    test('spawnAttached streams the output from the first byte, also what a program prints at once', async () => {
        const dir = hostDir();
        const client = await connectPtyHost({ dir });
        const terminal = await client.spawnAttached({ ...SH, args: ['-c', 'printf first-line; exit 4'], cwd: dir });
        const live = output(terminal);
        expect(await new Promise(done => terminal.onExit(done))).toMatchObject({ code: 4 });
        expect(live.text()).toContain('first-line');
        expect(terminal.info).toMatchObject({ attached: 1 });
        client.close();
    }, 20000);

    test('a client without the token is turned away', async () => {
        const dir = hostDir();
        (await connectPtyHost({ dir })).close();
        const reply = await new Promise<string>((resolve, reject) => {
            const socket = createConnection(socketPath(dir));
            let text = '';
            socket.on('data', chunk => text += chunk);
            socket.on('close', () => resolve(text));
            socket.on('error', reject);
            socket.write(JSON.stringify({ type: 'hello', id: 1, token: 'f'.repeat(64), protocol: 1 }) + '\n');
            socket.write(JSON.stringify({ type: 'list', id: 2 }) + '\n');
        });
        expect(JSON.parse(reply.trim())).toEqual({ type: 'response', id: 1, ok: false, error: 'Wrong token.' });
        expect(readFileSync(tokenPath(dir), 'utf8')).toMatch(/^[0-9a-f]{64}$/);
    }, 20000);

    test('a host folder that other users can enter is refused', () => {
        const dir = join(hostDir(), 'open');
        mkdirSync(dir, { mode: 0o755 });
        chmodSync(dir, 0o755);
        expect(() => ensureDir(dir)).toThrow(/must be 0700/);
    });

    test('the command lists and stops terminals, and an idle host exits on its own', async () => {
        const dir = hostDir();
        const client = await connectPtyHost({ dir, host: { idleTimeout: 300 } });
        const info = await client.spawn({ ...SH, cwd: dir, group: 'crm' });
        const { stdout } = await run(process.execPath, [hostMain(), 'list', '--dir', dir]);
        expect(stdout).toContain(`${info.id}\trunning\tpid ${info.pid}\tcrm`);
        await run(process.execPath, [hostMain(), 'kill', info.id, '--dir', dir]);
        expect(await client.list()).toEqual([]);
        client.close();
        await until(async () => !await answers(socketPath(dir)), 5000);
        await expect(run(process.execPath, [hostMain(), 'stop', '--dir', dir])).rejects.toMatchObject({ code: 1 });

        const other = hostDir();
        const second = await connectPtyHost({ dir: other });
        await second.spawn({ ...SH, cwd: other });
        await run(process.execPath, [hostMain(), 'stop', '--dir', other]);
        await until(async () => !await answers(socketPath(other)), 5000);
    }, 20000);
});

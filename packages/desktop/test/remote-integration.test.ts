import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { connectPtyHost } from '@appling/pty-host';
import type { ConnectionState } from '../src/remote/connection.js';
import { RemoteRepo } from '../src/remote/remote-repo.js';

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
            ptyDir: join(dir, 'local-pty'),
            backoff: { initial: 200, factor: 2, max: 2000, attempts: 10 },
            onState: state => states.push(state),
            onProgress: line => progress.push(line),
            onConnected: () => connects++
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
});

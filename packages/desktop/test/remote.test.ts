import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, describe, expect, test, vi } from 'vitest';
import { parseCodeWorkspace, printCodeWorkspace } from '../src/code-workspace.js';
import { RailStatus, railLines } from '../src/rail-status.js';
import { Repos } from '../src/repos.js';
import { Workspaces } from '../src/workspaces.js';
import { BACKOFF, backoffDelay, Connection, type ConnectionState } from '../src/remote/connection.js';
import { containerPlan, imageTag, parseDevcontainer, parseDevcontainerUp, readDevcontainer } from '../src/remote/devcontainer.js';
import { Forward } from '../src/remote/forward.js';
import { installPlan, layout, nodeAsset, parseProbe, parseUname, shaFromSums, unpackScript, type Probe } from '../src/remote/install.js';
import { fromVscodeUri, isRemoteId, locationId, locationName, parseLocation, repoId, toVscodeUri } from '../src/remote/location.js';
import { connectionContribution } from '../src/remote/rail.js';
import { readyPort } from '../src/remote/relay.js';
import { applies, parseSshConfig, readSshHosts } from '../src/remote/ssh-config.js';
import { agentScript, dockerExecArgs, LocalTransport, shellQuote, sshArgs, wslArgs } from '../src/remote/transport.js';
import { encodeFrame, FrameReader } from '../src/remote/reverse.js';

const temp: string[] = [];
afterAll(() => temp.forEach(dir => rmSync(dir, { recursive: true, force: true })));
function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'appling-remote-'));
    temp.push(dir);
    return dir;
}

describe('locations', () => {
    test('ssh, wsl and dev container URIs parse and print canonically', () => {
        expect(parseLocation('ssh://shop/srv/shop')).toEqual({ kind: 'ssh', host: 'shop', path: '/srv/shop' });
        expect(parseLocation('ssh://alex@10.0.0.2:2222/srv/shop/')).toEqual({ kind: 'ssh', host: '10.0.0.2', user: 'alex', port: 2222, path: '/srv/shop' });
        expect(parseLocation('ssh://shop/~/src/shop')).toEqual({ kind: 'ssh', host: 'shop', path: '~/src/shop' });
        expect(parseLocation('ssh://[::1]:22/x')).toMatchObject({ host: '::1', port: 22 });
        expect(parseLocation('wsl://Ubuntu-24.04/home/alex/shop')).toEqual({ kind: 'wsl', distro: 'Ubuntu-24.04', path: '/home/alex/shop' });
        expect(parseLocation('devcontainer:///work/shop')).toEqual({ kind: 'container', folder: '/work/shop' });
        expect(parseLocation('shop', '/work')).toEqual({ kind: 'local', path: '/work/shop' });
        for (const id of ['ssh://alex@10.0.0.2:2222/srv/shop', 'ssh://shop/~/src/shop', 'wsl://Ubuntu/home/a%20b', 'devcontainer:///work/shop', 'ssh://[::1]:22/x']) {
            expect(locationId(parseLocation(id))).toBe(id);
        }
        expect(() => parseLocation('ssh://shop')).toThrow(/no path/);
        expect(() => parseLocation('ssh://shop:99999/x')).toThrow(/port/);
        expect(() => parseLocation('ftp://x/y')).toThrow(/unknown/);
    });

    test('repo ids: local paths resolve, remote ones stay; names show the host', () => {
        expect(repoId('/work/./shop')).toBe('/work/shop');
        expect(repoId('ssh://shop/srv/x/')).toBe('ssh://shop/srv/x');
        expect(repoId('vscode-remote://ssh-remote+shop/srv/x')).toBe('ssh://shop/srv/x');
        expect(isRemoteId('ssh://a/b') && isRemoteId('wsl://a/b') && !isRemoteId('/a/b')).toBe(true);
        expect(locationName(parseLocation('ssh://shop/srv/x'))).toBe('x [shop]');
        expect(locationName(parseLocation('wsl://Ubuntu/home/x'))).toBe('x [WSL: Ubuntu]');
    });

    test('VS Code remote URIs both ways', () => {
        expect(fromVscodeUri('vscode-remote://ssh-remote+shop/srv/shop')).toEqual({ kind: 'ssh', host: 'shop', path: '/srv/shop' });
        expect(fromVscodeUri('vscode-remote://ssh-remote%2Balex@shop/srv/shop'.replace('%2B', '+'))).toEqual({ kind: 'ssh', host: 'shop', user: 'alex', path: '/srv/shop' });
        const hexHost = Buffer.from(JSON.stringify({ hostName: 'shop.example.com', user: 'deploy', port: 2200 })).toString('hex');
        expect(fromVscodeUri(`vscode-remote://ssh-remote+${hexHost}/srv`)).toEqual({ kind: 'ssh', host: 'shop.example.com', user: 'deploy', port: 2200, path: '/srv' });
        expect(fromVscodeUri('vscode-remote://wsl+Ubuntu/home/alex/x')).toEqual({ kind: 'wsl', distro: 'Ubuntu', path: '/home/alex/x' });
        const hexPath = Buffer.from('/work/shop').toString('hex');
        expect(fromVscodeUri(`vscode-remote://dev-container+${hexPath}/workspaces/shop`)).toEqual({ kind: 'container', folder: '/work/shop', workspace: '/workspaces/shop' });
        const hexJson = Buffer.from(JSON.stringify({ hostPath: '/work/shop', configFile: { path: '/work/shop/.devcontainer/devcontainer.json' } })).toString('hex');
        expect(fromVscodeUri(`vscode-remote://dev-container+${hexJson}/w`)).toMatchObject({ folder: '/work/shop', workspace: '/w' });
        expect(() => fromVscodeUri('vscode-remote://codespaces+x/y')).toThrow(/not supported/);

        for (const uri of ['vscode-remote://ssh-remote+shop/srv/shop', 'vscode-remote://wsl+Ubuntu/home/x', `vscode-remote://dev-container+${hexPath}/workspaces/shop`]) {
            expect(toVscodeUri(fromVscodeUri(uri))).toBe(uri);
        }
        expect(fromVscodeUri(toVscodeUri({ kind: 'ssh', host: 'h', user: 'u', port: 2201, path: '/p' }))).toEqual({ kind: 'ssh', host: 'h', user: 'u', port: 2201, path: '/p' });
        expect(toVscodeUri({ kind: 'container', folder: '/work/shop' })).toBe(`vscode-remote://dev-container+${hexPath}/workspaces/shop`);
    });
});

describe('ssh config', () => {
    const config = `
# global
User fallback
Host shop shop-staging
    HostName shop.example.com
    Port 2200
Host *.internal !secret.internal
    User ops
Host build
    HostName = 10.0.0.9
    User builder
Host *
    User late
    Port 22
Match host shop
    User matched
Include extra/*.conf
`;
    test('aliases without wildcards, first value wins, Host * applies too, Match is skipped', () => {
        expect(parseSshConfig(config, () => ['Host extra\n  HostName extra.example.com'])).toEqual([
            { alias: 'shop', hostName: 'shop.example.com', port: 2200, user: 'fallback' },
            { alias: 'shop-staging', hostName: 'shop.example.com', port: 2200, user: 'fallback' },
            { alias: 'build', hostName: '10.0.0.9', user: 'fallback', port: 22 },
            { alias: 'extra', hostName: 'extra.example.com', user: 'fallback', port: 22 }
        ]);
        expect(parseSshConfig('Host a\n  User x\nHost *\n  User y\n  Port 2')).toEqual([{ alias: 'a', user: 'x', port: 2 }]);
        expect(applies(['*.internal', '!secret.internal'], 'db.internal')).toBe(true);
        expect(applies(['*.internal', '!secret.internal'], 'secret.internal')).toBe(false);
    });

    test('reads the file and its includes relative to ~/.ssh; no file is no hosts', () => {
        const home = tempDir();
        mkdirSync(join(home, '.ssh', 'conf.d'), { recursive: true });
        writeFileSync(join(home, '.ssh', 'config'), 'Include conf.d/*.conf\nHost main\n');
        writeFileSync(join(home, '.ssh', 'conf.d', 'a.conf'), 'Host from-include\n  User inc\n');
        expect(readSshHosts(join(home, '.ssh', 'config'), home)).toEqual([{ alias: 'from-include', user: 'inc' }, { alias: 'main' }]);
        expect(readSshHosts(join(home, 'nope'), home)).toEqual([]);
    });
});

describe('dev containers', () => {
    test('devcontainer.json with comments: image, Dockerfile, variables, defaults', () => {
        const folder = tempDir();
        mkdirSync(join(folder, '.devcontainer'));
        writeFileSync(join(folder, '.devcontainer', 'devcontainer.json'), `{
            // a comment
            "name": "shop",
            "build": { "dockerfile": "Dockerfile", "context": "..", "args": { "V": "\${localEnv:NODE_V:24}" } },
            "remoteUser": "node",
            "containerEnv": { "WS": "\${containerWorkspaceFolder}" },
            "runArgs": ["--init"],
        }`);
        const config = readDevcontainer(folder, {});
        expect(config).toMatchObject({
            name: 'shop', dockerfile: join(folder, '.devcontainer', 'Dockerfile'), context: folder, buildArgs: { V: '24' },
            workspaceFolder: `/workspaces/${folder.split('/').pop()}`, user: 'node', runArgs: ['--init'], compose: false
        });
        expect(config.containerEnv.WS).toBe(config.workspaceFolder);
        expect(config.workspaceMount).toBe(`type=bind,source=${folder},target=${config.workspaceFolder}`);
        const plan = containerPlan(folder, config);
        expect(plan.find).toEqual(['ps', '-a', '-q', '--filter', `label=devcontainer.local_folder=${folder}`]);
        expect(plan.build).toEqual(['build', '-f', config.dockerfile, '-t', imageTag(folder), '--build-arg', 'V=24', folder]);
        expect(plan.run).toEqual(expect.arrayContaining(['run', '-d', '--mount', config.workspaceMount, '-e', `WS=${config.workspaceFolder}`, '--init', imageTag(folder)]));
        expect(plan.start('abc')).toEqual(['start', 'abc']);
    });

    test('an image and a workspace folder; compose needs the CLI; nothing to run is an error', () => {
        const image = parseDevcontainer('{ "image": "mcr.microsoft.com/devcontainers/base", "workspaceFolder": "/src/${localWorkspaceFolderBasename}" }', '/w/x/.devcontainer.json', '/w/x');
        expect(image).toMatchObject({ image: 'mcr.microsoft.com/devcontainers/base', workspaceFolder: '/src/x' });
        expect(containerPlan('/w/x', image).build).toBeUndefined();
        const compose = parseDevcontainer('{ "dockerComposeFile": "c.yml", "service": "app" }', '/w/x/.devcontainer.json', '/w/x');
        expect(() => containerPlan('/w/x', compose)).toThrow(/devcontainer CLI/);
        expect(() => parseDevcontainer('{}', 'f', '/w/x')).toThrow(/no image/);
        expect(parseDevcontainerUp('log line\n{"outcome":"success","containerId":"c1","remoteUser":"node","remoteWorkspaceFolder":"/workspaces/x"}\n'))
            .toEqual({ containerId: 'c1', user: 'node', workspaceFolder: '/workspaces/x' });
        expect(() => parseDevcontainerUp('{"outcome":"error","message":"no docker"}')).toThrow(/no docker/);
    });
});

describe('transports', () => {
    test('shell quoting and the command lines of ssh, docker and wsl', () => {
        expect(shellQuote('/a/b')).toBe('/a/b');
        expect(shellQuote("it's")).toBe(`'it'\\''s'`);
        expect(agentScript({ node: '/r/node', agent: '/r/a b/agent.js' }, ['ide', '/srv/x'])).toBe(`/r/node '/r/a b/agent.js' ide /srv/x`);
        const ssh = sshArgs({ kind: 'ssh', host: 'shop', user: 'alex', port: 2200, path: '/x' }, '/tmp/c', { args: ['-F', '/dev/null'] });
        expect(ssh.master).toEqual(expect.arrayContaining(['-M', '-N', '-S', '/tmp/c', 'BatchMode=yes', 'ServerAliveInterval=10', '-F', '/dev/null']));
        expect(ssh.master.slice(-5)).toEqual(['-p', '2200', '-l', 'alex', 'shop']);
        expect(ssh.exec('echo hi').at(-1)).toBe(`sh -c 'echo hi'`);
        expect(ssh.stream(4410)).toEqual(expect.arrayContaining(['-S', '/tmp/c', '-W', '127.0.0.1:4410']));
        expect(ssh.check).toContain('check');
        expect(dockerExecArgs('c1', 'ls', 'node')).toEqual(['exec', '-i', '-u', 'node', 'c1', 'sh', '-c', 'ls']);
        expect(wslArgs('Ubuntu', 'ls')).toEqual(['-d', 'Ubuntu', '--exec', 'sh', '-c', 'ls']);
    });

    test('the local transport runs scripts with stdin and streams to ports', async () => {
        const transport = new LocalTransport();
        expect(await transport.exec('cat; echo " done"', { input: Buffer.from('in') })).toMatchObject({ code: 0, stdout: 'in done\n' });
        const server = createServer(socket => socket.end('pong'));
        await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
        const forward = await Forward.listen({}, () => transport.stream({ port: (server.address() as { port: number }).port }));
        const { connect } = await import('node:net');
        const answer = await new Promise<string>(resolve => {
            let text = '';
            const client = connect(forward.port!, '127.0.0.1');
            client.on('data', chunk => text += chunk);
            client.on('close', () => resolve(text));
        });
        expect(answer).toBe('pong');
        await forward.close();
        server.close();
    });

    test('ssh reverse forwards go through the control master', () => {
        const args = sshArgs({ kind: 'ssh', host: 'shop', path: '/r' }, '/tmp/ctl');
        expect(args.forward('127.0.0.1:0:127.0.0.1:4100')).toEqual(['-S', '/tmp/ctl', '-O', 'forward', '-R', '127.0.0.1:0:127.0.0.1:4100', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15', 'shop']);
        expect(args.cancel('127.0.0.1:5000:127.0.0.1:4100')).toContain('cancel');
    });

    test('reverse forward frames split across chunks', () => {
        const bytes = Buffer.concat([encodeFrame(1, 7), encodeFrame(2, 7, Buffer.from('hello')), encodeFrame(3, 7)]);
        const reader = new FrameReader();
        const frames = [...reader.push(bytes.subarray(0, 5)), ...reader.push(bytes.subarray(5, 20)), ...reader.push(bytes.subarray(20))];
        expect(frames.map(f => [f.type, f.id, f.payload.toString()])).toEqual([[1, 7, ''], [2, 7, 'hello'], [3, 7, '']]);
    });

    test('a reverse forward over the agent\'s stdio carries connections made there to a port here, and keeps its port', async () => {
        // the agent runs here: `reverse` is how dev containers and WSL reach a port of Desktop's machine
        const transport = new LocalTransport();
        transport.agent = { node: process.execPath, agent: join(import.meta.dirname, '../out/remote/agent.js') };
        const { createServer: createHttp, request } = await import('node:http');
        const server = createHttp((req, res) => {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => res.end(`${req.method} ${req.url} ${req.headers.host} ${body}`));
        });
        await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
        const local = (server.address() as { port: number }).port;
        const call = (port: number, body: string) => new Promise<string>((resolve, reject) => {
            const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/hooks/Stop' }, res => {
                let text = '';
                res.on('data', chunk => text += chunk);
                res.on('end', () => resolve(text));
            });
            req.on('error', reject);
            req.end(body);
        });
        const forward = await transport.reverse(local);
        expect(forward.port).not.toBe(local);
        const answers = await Promise.all([call(forward.port, 'one'), call(forward.port, 'x'.repeat(200000))]);
        expect(answers[0]).toBe(`POST /hooks/Stop 127.0.0.1:${forward.port} one`);
        expect(answers[1]).toHaveLength(`POST /hooks/Stop 127.0.0.1:${forward.port} `.length + 200000);
        let ended = false;
        forward.onEnd(() => ended = true);
        await forward.close();
        // a new forward asks for the same port there again
        const again = await transport.reverse(local, forward.port);
        expect(again.port).toBe(forward.port);
        expect(await call(again.port, 'two')).toContain('two');
        await again.close();
        expect(ended).toBe(false);
        server.close();
    });

    test('a forward without a target holds connections until it gets one', async () => {
        const forward = await Forward.listen({}, undefined, 5000);
        const { connect } = await import('node:net');
        const client = connect(forward.port!, '127.0.0.1');
        const received = new Promise<string>(resolve => client.on('data', chunk => resolve(String(chunk))));
        await new Promise(done => client.once('connect', done));
        client.write('ping');
        await new Promise(done => setTimeout(done, 50));
        forward.retarget(() => {
            const echo = new PassThrough();
            return echo;
        });
        expect(await received).toBe('ping');
        expect(forward.connections).toBe(1);
        forward.retarget(undefined, true);
        await new Promise(done => client.once('close', done));
        await forward.close();
    });
});

describe('install', () => {
    const probe = (over: Partial<Probe> = {}): Probe => ({ platform: 'linux', arch: 'x64', home: '/home/a', root: '/home/a/.appling-server', musl: false, bundle: false, node: false, code: false, ...over });

    test('uname and the probe', () => {
        expect(parseUname('Linux x86_64\n')).toEqual({ platform: 'linux', arch: 'x64' });
        expect(parseUname('Linux aarch64')).toEqual({ platform: 'linux', arch: 'arm64' });
        expect(parseUname('Darwin arm64')).toEqual({ platform: 'darwin', arch: 'arm64' });
        expect(() => parseUname('FreeBSD amd64')).toThrow(/Linux or macOS/);
        expect(parseProbe('Linux x86_64\n/home/a\n/home/a/.appling-server\nglibc\nbundle\n-\ncode\n')).toEqual(probe({ bundle: true, code: true }));
        expect(() => parseProbe('Linux x86_64\n\n')).toThrow(/home/);
    });

    test('the plan installs what is missing, the layout keeps versions apart', () => {
        const paths = layout('/home/a/.appling-server', '1.0.0-abc', '24.1.0', probe(), 'openvscode-server-v1-linux-x64');
        expect(paths).toEqual({
            root: '/home/a/.appling-server', server: '/home/a/.appling-server/1.0.0-abc',
            node: '/home/a/.appling-server/node/v24.1.0-linux-x64/bin/node', code: '/home/a/.appling-server/code/openvscode-server-v1-linux-x64'
        });
        expect(installPlan(probe(), paths, { nodeVersion: '24.1.0' }).map(s => s.what)).toEqual(['node', 'bundle']);
        expect(installPlan(probe({ node: true, bundle: true }), paths, { nodeVersion: '24.1.0' })).toEqual([]);
        expect(installPlan(probe({ node: true, bundle: true }), paths, { nodeVersion: '24.1.0', code: true }).map(s => s.what)).toEqual(['code']);
        const node = installPlan(probe(), paths, { nodeVersion: '24.1.0' })[0].script;
        expect(node).toContain('--strip-components=1 node-v24.1.0-linux-x64/bin/node');
        expect(() => installPlan(probe({ musl: true }), paths, { nodeVersion: '24.1.0' })).toThrow(/musl/);
        expect(nodeAsset('24.1.0', probe()).url).toBe('https://nodejs.org/dist/v24.1.0/node-v24.1.0-linux-x64.tar.gz');
        expect(shaFromSums('abc  node-v24.1.0-linux-x64.tar.gz\ndef  other\n', 'node-v24.1.0-linux-x64.tar.gz')).toBe('abc');
    });

    test('unpacking moves a complete folder into place and keeps one that won a race', async () => {
        const dir = tempDir();
        const src = join(dir, 'src');
        mkdirSync(join(src, 'x'), { recursive: true });
        writeFileSync(join(src, 'x', 'file'), 'one');
        const transport = new LocalTransport();
        const { tarStream } = await import('../src/remote/install.js');
        const target = join(dir, 'installed', 'v1');
        expect((await transport.exec(unpackScript(target, { strip: 1, marker: '.installed' }), { input: tarStream(src, ['x']) })).code).toBe(0);
        expect((await transport.exec(`cat ${target}/file; test -f ${target}/.installed && echo ok`)).stdout).toBe('oneok\n');
        writeFileSync(join(src, 'x', 'file'), 'two');
        expect((await transport.exec(unpackScript(target, { strip: 1 }), { input: tarStream(src, ['x']) })).code).toBe(0);
        expect((await transport.exec(`cat ${target}/file; ls ${dirname(target)}`)).stdout).toBe('onev1\n');
    });
});

function dirname(path: string): string {
    return path.slice(0, path.lastIndexOf('/'));
}

describe('reconnects', () => {
    function machine(results: (true | string)[], attempts = 3) {
        const timers: { callback: () => void, ms: number }[] = [];
        const states: string[] = [];
        let calls = 0;
        const connection = new Connection({
            connect: async () => {
                const result = results[calls++] ?? true;
                if (result !== true) throw new Error(result);
            },
            backoff: { ...BACKOFF, attempts },
            random: () => 0.5,
            setTimeout: (callback, ms) => timers.push({ callback, ms }),
            clearTimeout: () => undefined,
            onState: (state: ConnectionState, detail) => states.push(detail.retryIn !== undefined ? `${state} ${detail.retryIn}` : state)
        });
        const tick = async () => {
            const timer = timers.shift()!;
            timer.callback();
            await vi.waitFor(() => expect(connection.state).not.toBe('connecting'));
            await new Promise(done => setTimeout(done, 0));
        };
        return { connection, states, timers, tick, calls: () => calls };
    }

    test('backoff doubles up to the cap, with jitter', () => {
        expect([1, 2, 3, 4, 5, 6, 7].map(n => backoffDelay(n, BACKOFF, () => 0.5))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
        expect(backoffDelay(1, BACKOFF, () => 1)).toBe(1200);
        expect(backoffDelay(1, BACKOFF, () => 0)).toBe(800);
    });

    test('connects, drops, retries with backoff and connects again', async () => {
        const { connection, states, tick } = machine([true, 'down', 'down', true]);
        await connection.start();
        expect(connection.state).toBe('connected');
        connection.lost('network');
        expect(states).toEqual(['connecting', 'connected', 'reconnecting 1000']);
        await tick();
        expect(states.at(-1)).toBe('reconnecting 2000');
        await tick();
        expect(states.at(-1)).toBe('reconnecting 4000');
        await tick();
        expect(connection.state).toBe('connected');
        expect(connection.error).toBeUndefined();
    });

    test('the first connect fails at once; attempts run out into failed; retry starts over', async () => {
        const first = machine(['no such host']);
        await first.connection.start();
        expect(first.connection.state).toBe('failed');
        expect(first.connection.error).toBe('no such host');
        expect(first.timers).toEqual([]);
        await first.connection.retry();
        expect(first.connection.state).toBe('connected');

        const out = machine([true, 'down', 'down'], 2);
        await out.connection.start();
        out.connection.lost();
        await out.tick();
        await out.tick();
        await vi.waitFor(() => expect(out.connection.state).toBe('failed'));
        expect(out.connection.error).toBe('down');
    });

    test('a loss while not connected is ignored; close stops a pending retry', async () => {
        const { connection, timers, calls } = machine([true]);
        connection.lost();
        expect(connection.state).toBe('closed');
        await connection.start();
        connection.lost();
        connection.lost();
        expect(timers.length).toBe(1);
        await connection.close();
        timers[0].callback();
        await new Promise(done => setTimeout(done, 0));
        expect(connection.state).toBe('closed');
        expect(calls()).toBe(1);
    });
});

describe('desktop state for remote repos', () => {
    test('workspace files read and write VS Code remote folders next to local ones', () => {
        const file = '/work/team.code-workspace';
        const workspace = parseCodeWorkspace(JSON.stringify({
            folders: [
                { path: 'shop' },
                { uri: 'vscode-remote://ssh-remote+build/srv/api', name: 'api' },
                { uri: 'vscode-remote://wsl+Ubuntu/home/a/tools' },
                { uri: 'vscode-remote://codespaces+x/y' }
            ],
            settings: { a: 1 }
        }), file);
        expect(workspace.folders).toEqual([{ path: '/work/shop' }, { path: 'ssh://build/srv/api', name: 'api' }, { path: 'wsl://Ubuntu/home/a/tools' }]);
        expect(workspace.remote).toEqual([{ uri: 'vscode-remote://codespaces+x/y' }]);
        const printed = JSON.parse(printCodeWorkspace(file, [...workspace.folders, { path: 'devcontainer:///work/web' }], workspace));
        expect(printed.folders).toEqual([
            { path: 'shop' },
            { name: 'api', uri: 'vscode-remote://ssh-remote+build/srv/api' },
            { uri: 'vscode-remote://wsl+Ubuntu/home/a/tools' },
            { uri: `vscode-remote://dev-container+${Buffer.from('/work/web').toString('hex')}/workspaces/web` },
            { uri: 'vscode-remote://codespaces+x/y' }
        ]);
        expect(printed.settings).toEqual({ a: 1 });
    });

    test('workspaces, repos and the rail keep remote ids as they are', () => {
        const workspaces = new Workspaces();
        workspaces.open('/work/team.code-workspace', [{ path: '/work/shop' }, { path: 'ssh://build/srv/api' }]);
        expect(workspaces.addRepo('/work/team.code-workspace', 'wsl://Ubuntu/home/a/tools/')).toBe(true);
        expect([...workspaces.live()]).toEqual(['/work/shop', 'ssh://build/srv/api', 'wsl://Ubuntu/home/a/tools']);
        expect(workspaces.select('ssh://build/srv/api')).toBe(true);
        const repos = new Repos();
        expect(repos.add('ssh://build/srv/api').repo).toMatchObject({ id: 'ssh://build/srv/api', name: 'api [build]' });
        const rail = new RailStatus();
        rail.source('connection').set('ssh://build/srv/api', connectionContribution('reconnecting', { label: 'SSH build', attempt: 2, retryIn: 4000, error: 'The connection to SSH build was lost.' }));
        const status = rail.repo('ssh://build/srv/api');
        expect(status.connection).toBe('reconnecting');
        expect(railLines(status)).toEqual(['Reconnecting to SSH build (attempt 2, next in 4 s): The connection to SSH build was lost.']);
        expect(railLines({ ...rail.repo('ssh://build/srv/api'), ...connectionContribution('connected', { label: 'SSH build', attempt: 0 }) })).toContain('Connected to SSH build');
    });

    test('the ready message of a remote server names its port', () => {
        expect(readyPort({ type: 'ready', url: 'http://127.0.0.1:41234' })).toBe(41234);
        expect(readyPort({ type: 'status', errors: 1 })).toBeUndefined();
    });
});

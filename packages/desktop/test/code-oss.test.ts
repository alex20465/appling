import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { connectDesktop } from '../../vscode/src/desktop-bridge.js';
import { diffMessage, openMessage } from '@appling/ide/host-requests';
import { CodeBridge, parseExtensionMessage } from '../src/code-bridge.js';
import { CODE_SERVER, codeServerAsset, ensureCodeServer, type CodeServerRelease } from '../src/code-download.js';
import { CodeInstances, type InstanceStatus } from '../src/code-instances.js';
import { authorized, CodeProxy, PROXY_COOKIE, rewriteCookies, routeOf } from '../src/code-proxy.js';
import { boundPort, codeDirs, codeServerArgs, installExtension, repoKey, startCodeServer, type CodeServer } from '../src/code-server.js';
import { DEFAULT_CODE_VIEW, loadCodeViewSettings, splitBounds } from '../src/code-settings.js';
import { DEFAULT_KEYBINDINGS } from '../src/keybindings.js';
import { findCode, lineColumn, vscodeArgs, vscodeRemoteArgs } from '../src/vscode-cli.js';
import { vscodeUriAt } from '../src/remote/location.js';
import { posix, win32 } from 'node:path';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
    for (const step of cleanup.splice(0).reverse()) await step();
    vi.useRealTimers();
});

function temp(): string {
    return mkdtempSync(join(tmpdir(), 'appling-code-'));
}

function listen(server: Server): Promise<number> {
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
}

function get(url: string, headers: Record<string, string> = {}): Promise<{ status: number, headers: IncomingHttpHeaders, body: string }> {
    return new Promise((resolve, reject) => {
        request(url, { headers }, response => {
            let body = '';
            response.on('data', chunk => body += chunk);
            response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
        }).on('error', reject).end();
    });
}

test('the pinned openvscode-server has an archive per Linux platform and none elsewhere', () => {
    const asset = codeServerAsset('linux', 'x64')!;
    expect(asset.name).toBe(`openvscode-server-v${CODE_SERVER.version}-linux-x64`);
    expect(asset.url).toBe(`https://github.com/gitpod-io/openvscode-server/releases/download/openvscode-server-v${CODE_SERVER.version}/${asset.name}.tar.gz`);
    expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(codeServerAsset('linux', 'arm')?.name).toMatch(/-linux-armhf$/);
    expect(codeServerAsset('linux', 'arm64')?.name).toMatch(/-linux-arm64$/);
    expect(codeServerAsset('darwin', 'arm64')).toBeUndefined();
    expect(codeServerAsset('win32', 'x64')).toBeUndefined();
});

/** A fake release served from a local server: a `.tar.gz` with `bin/openvscode-server` in the expected folder. */
async function fakeRelease(): Promise<{ release: CodeServerRelease, requests: () => number }> {
    const dir = temp();
    const name = 'openvscode-server-v9.9.9-linux-x64';
    mkdirSync(join(dir, name, 'bin'), { recursive: true });
    writeFileSync(join(dir, name, 'bin', 'openvscode-server'), '#!/bin/sh\necho fake\n');
    execFileSync('tar', ['-czf', join(dir, 'archive.tar.gz'), '-C', dir, name]);
    const archive = readFileSync(join(dir, 'archive.tar.gz'));
    let count = 0;
    const server = createServer((req, res) => {
        count++;
        if (req.url !== `/${name}.tar.gz`) return res.writeHead(404).end();
        res.writeHead(200, { 'content-length': archive.length }).end(archive);
    });
    const port = await listen(server);
    cleanup.push(() => server.close());
    return {
        release: { version: '9.9.9', url: `http://127.0.0.1:${port}/{asset}`, sha256: { 'linux-x64': createHash('sha256').update(archive).digest('hex') } },
        requests: () => count
    };
}

test('the server is downloaded once, verified and unpacked into the cache; concurrent calls share the download', async () => {
    const { release, requests } = await fakeRelease();
    const cache = temp();
    const progress: number[] = [];
    const options = { platform: 'linux', arch: 'x64', release, onProgress: (received: number) => progress.push(received) };
    const [binary, again] = await Promise.all([ensureCodeServer(cache, options), ensureCodeServer(cache, options)]);
    expect(binary).toBe(join(cache, 'openvscode-server-v9.9.9-linux-x64', 'bin', 'openvscode-server'));
    expect(again).toBe(binary);
    expect(readFileSync(binary, 'utf8')).toContain('echo fake');
    expect(requests()).toBe(1);
    expect(progress.length).toBeGreaterThan(0);
    expect(await ensureCodeServer(cache, options)).toBe(binary);
    expect(requests()).toBe(1);
    expect(readdirSync(cache)).toEqual(['openvscode-server-v9.9.9-linux-x64']);
});

test('an archive with the wrong digest is rejected and leaves nothing in the cache', async () => {
    const { release } = await fakeRelease();
    const cache = temp();
    const wrong = { ...release, sha256: { 'linux-x64': '0'.repeat(64) } };
    await expect(ensureCodeServer(cache, { platform: 'linux', arch: 'x64', release: wrong })).rejects.toThrow(/expected 0{64}; it was not installed/);
    expect(readdirSync(cache)).toEqual([]);
    await expect(ensureCodeServer(cache, { platform: 'darwin', arch: 'arm64' })).rejects.toThrow(/no build for darwin-arm64/);
});

/** A launch that records what runs, with handles that record their close. */
function launcher() {
    const started: string[] = [];
    const closed: string[] = [];
    let release: (() => void) | undefined;
    let hold = false;
    const launch = async (repo: string) => {
        started.push(repo);
        if (hold) await new Promise<void>(resolve => release = resolve);
        return { repo, close: () => { closed.push(repo); } };
    };
    return { launch, started, closed, hold: (on: boolean) => hold = on, release: () => release?.() };
}

test('lazy instances start on first open and are suspended after the idle time out of sight', async () => {
    vi.useFakeTimers();
    const { launch, started, closed } = launcher();
    const statuses: InstanceStatus[] = [];
    const instances = new CodeInstances({ launch, lifecycle: 'lazy', idleMs: 1000, onChange: (_repo, state) => statuses.push(state.status) });
    instances.add('/a');
    expect(started).toEqual([]);
    instances.visible('/a', true);
    const first = await instances.start('/a');
    expect(await instances.start('/a')).toBe(first);
    expect(started).toEqual(['/a']);

    // on screen, it never suspends
    await vi.advanceTimersByTimeAsync(5000);
    expect(instances.get('/a')?.status).toBe('running');

    // out of sight it counts down; coming back in time stops the count
    instances.visible('/a', false);
    await vi.advanceTimersByTimeAsync(900);
    instances.visible('/a', true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(closed).toEqual([]);

    instances.visible('/a', false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(instances.get('/a')?.status).toBe('suspended');
    expect(closed).toEqual(['/a']);

    // opening it again starts a new instance
    instances.visible('/a', true);
    await instances.start('/a');
    expect(started).toEqual(['/a', '/a']);
    expect(statuses).toEqual(['starting', 'running', 'suspended', 'starting', 'running']);
});

test('always alive instances start with the repo and never suspend; switching to lazy suspends those out of sight', async () => {
    vi.useFakeTimers();
    const { launch, started, closed } = launcher();
    const instances = new CodeInstances({ launch, lifecycle: 'always', idleMs: 1000 });
    instances.add('/a');
    instances.add('/b');
    instances.add('/a');
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(['/a', '/b']);
    instances.visible('/b', true);
    await vi.advanceTimersByTimeAsync(60000);
    expect(instances.get('/a')?.status).toBe('running');

    instances.configure('lazy', 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(instances.get('/a')?.status).toBe('suspended');
    expect(instances.get('/b')?.status).toBe('running');

    instances.configure('always', 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(instances.get('/a')?.status).toBe('running');

    await instances.remove('/b');
    expect(instances.get('/b')).toBeUndefined();
    await instances.closeAll();
    expect(closed.sort()).toEqual(['/a', '/a', '/b']);
});

test('an instance stopped while it starts is closed when it comes up; one that ends on its own fails and restarts', async () => {
    const { launch, closed, hold, release } = launcher();
    const instances = new CodeInstances({ launch, lifecycle: 'lazy', idleMs: 1000 });
    instances.add('/a');
    hold(true);
    const starting = instances.start('/a');
    expect(instances.get('/a')?.status).toBe('starting');
    await instances.suspend('/a');
    release();
    await expect(starting).rejects.toThrow(/stopped while it started/);
    expect(closed).toEqual(['/a']);
    expect(instances.get('/a')?.status).toBe('suspended');

    hold(false);
    const handle = await instances.start('/a');
    instances.exited('/a', handle, 'crashed');
    expect(instances.get('/a')).toMatchObject({ status: 'failed', error: 'crashed' });
    expect((await instances.start('/a')).repo).toBe('/a');
    expect(instances.get('/a')?.status).toBe('running');
    await expect(instances.start('/nowhere')).rejects.toThrow(/not open/);
});

test('the proxy routes by repo key, admits only its cookie and hands each instance its own connection token', async () => {
    const seen: { url?: string, cookie?: string }[] = [];
    const upstream = createServer((req, res) => {
        seen.push({ url: req.url, cookie: req.headers.cookie });
        res.writeHead(200, { 'set-cookie': ['vscode-tkn=secret; Max-Age=60', 'other=1'] }).end(`hello ${req.url}`);
    });
    const sockets = new WebSocketServer({ server: upstream });
    sockets.on('connection', (ws, req) => ws.send(`ws ${req.headers.cookie}`));
    const port = await listen(upstream);
    const bridged: string[] = [];
    const proxy = new CodeProxy({ secret: 's3cret', bridge: (req, socket) => { bridged.push(req.url!); socket.destroy(); } });
    await proxy.listen();
    cleanup.push(() => proxy.close(), () => upstream.close(), () => sockets.close());
    const cookie = `${PROXY_COOKIE}=s3cret; theme=dark`;

    expect((await get(`${proxy.origin}/r/abc/`)).status).toBe(403);
    expect((await get(`${proxy.origin}/r/abc/`, { cookie: `${PROXY_COOKIE}=wrong` })).status).toBe(403);
    expect((await get(`${proxy.origin}/r/abc/`, { cookie })).status).toBe(503);
    proxy.route('abc', { port, token: 'tok-a' });
    const reply = await get(`${proxy.origin}/r/abc/static/x.js?y=1`, { cookie: `${cookie}; vscode-tkn=stale` });
    expect(reply.status).toBe(200);
    expect(reply.body).toBe('hello /r/abc/static/x.js?y=1');
    expect(seen.at(-1)?.cookie).toBe('theme=dark; vscode-tkn=tok-a');
    expect(reply.headers['set-cookie']).toEqual(['other=1']);
    expect((await get(`${proxy.origin}/elsewhere`, { cookie })).status).toBe(403);

    const ws = new WebSocket(`${proxy.origin.replace('http', 'ws')}/r/abc/socket`, { headers: { cookie } });
    expect(await new Promise(resolve => ws.once('message', data => resolve(String(data))))).toBe('ws theme=dark; vscode-tkn=tok-a');
    ws.close();
    const refused = new WebSocket(`${proxy.origin.replace('http', 'ws')}/r/abc/socket`);
    expect(await new Promise(resolve => refused.once('unexpected-response', (_req, res) => resolve(res.statusCode)))).toBe(403);
    const bridge = new WebSocket(proxy.bridgeUrl);
    await new Promise(resolve => bridge.once('error', resolve).once('close', resolve));
    expect(bridged).toEqual(['/bridge']);

    proxy.route('abc', undefined);
    expect((await get(`${proxy.origin}/r/abc/`, { cookie })).status).toBe(503);
    expect(proxy.url('abc', '/work/my shop')).toBe(`${proxy.origin}/r/abc/?folder=%2Fwork%2Fmy%20shop`);
});

test('proxy helpers parse routes and cookies', () => {
    expect(routeOf('/r/0f3a/stable-1/static')).toBe('0f3a');
    expect(routeOf('/r/0f3a?x')).toBe('0f3a');
    expect(routeOf('/r/0f3a')).toBe('0f3a');
    expect(routeOf('/r/../x')).toBeUndefined();
    expect(routeOf('/x/0f3a/')).toBeUndefined();
    expect(rewriteCookies(undefined, 't')).toBe('vscode-tkn=t');
    expect(rewriteCookies('a=1; appling-code=s; vscode-tkn=old', 't')).toBe('a=1; vscode-tkn=t');
    expect(authorized('a=1; appling-code=s', 's')).toBe(true);
    expect(authorized('appling-code=s2', 's')).toBe(false);
    expect(authorized(undefined, 's')).toBe(false);
});

test('bridge messages from the extension are parsed strictly', () => {
    expect(parseExtensionMessage('{"type":"hello","token":"t"}')).toEqual({ type: 'hello', token: 't' });
    expect(parseExtensionMessage('{"type":"cursor","uri":"file:///a.appling","offset":3}')).toEqual({ type: 'cursor', uri: 'file:///a.appling', offset: 3 });
    expect(parseExtensionMessage('{"type":"cursor","uri":"file:///a.appling","offset":-1}')).toBeUndefined();
    expect(parseExtensionMessage('{"type":"reveal"}')).toBeUndefined();
    expect(parseExtensionMessage('not json')).toBeUndefined();
    expect(parseExtensionMessage('null')).toBeUndefined();
});

/** A CodeBridge behind a CodeProxy, as in the app. */
async function bridgeSetup() {
    const cursors: [string, string, number][] = [];
    const bridge = new CodeBridge({ onCursor: (repo, uri, offset) => cursors.push([repo, uri, offset]), helloTimeout: 500 });
    const proxy = new CodeProxy({ bridge: (req, socket, head) => bridge.upgrade(req, socket, head) });
    await proxy.listen();
    cleanup.push(() => proxy.close(), () => bridge.close());
    return { bridge, proxy, cursors };
}

test('the bridge admits a known token only and speaks for that repo', async () => {
    const { bridge, proxy, cursors } = await bridgeSetup();
    const stale = bridge.token('/a');
    const token = bridge.token('/a');
    const closed = (ws: WebSocket) => new Promise<number>(resolve => ws.once('close', code => resolve(code)));

    const unknown = new WebSocket(proxy.bridgeUrl);
    unknown.once('open', () => unknown.send(JSON.stringify({ type: 'hello', token: stale })));
    expect(await closed(unknown)).toBe(4003);
    const silent = new WebSocket(proxy.bridgeUrl);
    expect(await closed(silent)).toBe(4001);

    const ws = new WebSocket(proxy.bridgeUrl);
    const messages: unknown[] = [];
    ws.on('message', data => messages.push(JSON.parse(String(data))));
    ws.once('open', () => ws.send(JSON.stringify({ type: 'hello', token })));
    await vi.waitFor(() => expect(messages).toEqual([{ type: 'welcome' }]));
    expect(bridge.connected('/a')).toBe(true);
    ws.send(JSON.stringify({ type: 'cursor', uri: 'file:///a/m.appling', offset: 12 }));
    await vi.waitFor(() => expect(cursors).toEqual([['/a', 'file:///a/m.appling', 12]]));
    expect(bridge.reveal('/a', 'file:///a/m.appling', 3, 9)).toBe(true);
    expect(bridge.reveal('/b', 'file:///b/m.appling', 3, 9)).toBe(false);
    await vi.waitFor(() => expect(messages[1]).toEqual({ type: 'reveal', uri: 'file:///a/m.appling', start: 3, end: 9 }));

    bridge.revoke('/a');
    expect(await closed(ws)).toBe(1005);
    expect(bridge.connected('/a')).toBe(false);
});

test('the Appling extension bridge syncs the selection both ways and reconnects', async () => {
    const { bridge, proxy, cursors } = await bridgeSetup();
    const token = bridge.token('/repo');
    let report: ((uri: string, offset: number) => void) | undefined;
    const reveals: [string, number, number][] = [];
    const diffs: unknown[][] = [];
    // a diff asked for while the code view still starts waits for the extension
    bridge.send('/repo', diffMessage('/repo', { path: 'm/sales.appling', rev: 'HEAD~1', line: 4 })!);
    const client = connectDesktop({
        url: proxy.bridgeUrl, token, debounce: 10, retry: 20,
        WebSocket: globalThis.WebSocket,
        editor: {
            onCursor: listener => { report = listener; return { dispose: () => report = undefined }; },
            reveal: (uri, start, end) => { reveals.push([uri, start, end]); },
            diff: (...args) => { diffs.push(args); }
        }
    });
    cleanup.push(() => client.dispose());
    await client.welcomed;
    await vi.waitFor(() => expect(diffs).toEqual([['/repo/m/sales.appling', '/repo/m/sales.appling', 'HEAD~1', 4]]));

    report!('file:///repo/a.appling', 5);
    report!('file:///repo/a.appling', 7);
    await vi.waitFor(() => expect(cursors).toEqual([['/repo', 'file:///repo/a.appling', 7]]));

    bridge.reveal('/repo', 'file:///repo/b.appling', 40, 90);
    await vi.waitFor(() => expect(reveals).toEqual([['file:///repo/b.appling', 40, 90]]));
    // the cursor move the reveal causes is not echoed back
    report!('file:///repo/b.appling', 40);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(cursors).toHaveLength(1);

    // the connection drops (the bridge closes its sockets), and the client comes back with the same token
    for (const socket of (bridge as unknown as { sockets: Map<string, Set<WebSocket>> }).sockets.get('/repo')!) socket.terminate();
    await new Promise(resolve => setTimeout(resolve, 100));
    await client.welcomed;
    expect(bridge.connected('/repo')).toBe(true);
    report!('file:///repo/a.appling', 1);
    await vi.waitFor(() => expect(cursors.at(-1)).toEqual(['/repo', 'file:///repo/a.appling', 1]));
    client.dispose();
    expect(report).toBeUndefined();
});

test('text diffs stay inside the repo and take plain revisions only', () => {
    expect(diffMessage('/repo', { path: 'a.appling', before: 'old/a.appling', rev: 'abc123', line: 3 }))
        .toEqual({ type: 'diff', path: '/repo/a.appling', before: '/repo/old/a.appling', rev: 'abc123', line: 3 });
    expect(diffMessage('/repo', { path: 'a.appling', rev: 'HEAD~2', line: 0 })).toEqual({ type: 'diff', path: '/repo/a.appling', before: '/repo/a.appling', rev: 'HEAD~2' });
    expect(diffMessage('/repo', { path: '../etc/passwd', rev: 'HEAD' })).toBeUndefined();
    expect(diffMessage('/repo', { path: 'a.appling', before: '/etc/passwd', rev: 'HEAD' })).toBeUndefined();
    expect(diffMessage('/repo', { path: 'a.appling', rev: '--output=x' })).toBeUndefined();
    expect(diffMessage('/repo', { path: 'a.appling', rev: 'a b' })).toBeUndefined();
});

test('a remote repo\'s diffs and code jumps carry the paths of its machine, also from a Windows Desktop', () => {
    // the remote code view runs on that machine: paths resolve against its folder there with POSIX rules
    const root = '/home/dev/shop';
    expect(diffMessage(root, { path: 'm/a.appling', rev: 'HEAD', line: 2 }, posix)).toEqual({ type: 'diff', path: '/home/dev/shop/m/a.appling', before: '/home/dev/shop/m/a.appling', rev: 'HEAD', line: 2 });
    expect(diffMessage(root, { path: '../../etc/passwd', rev: 'HEAD' }, posix)).toBeUndefined();
    expect(openMessage(root, { path: 'app/models.py', start: 3, end: 9 }, posix)).toEqual({ type: 'open', path: '/home/dev/shop/app/models.py', start: 3, end: 9 });
    // an absolute path of that machine (the IDE server there names it so) stays as it is
    expect(openMessage(root, { path: '/home/dev/shop/app/views.py', start: 1 }, posix)).toEqual({ type: 'open', path: '/home/dev/shop/app/views.py', start: 1, end: 1 });
    expect(openMessage(root, { path: '/home/dev/app/views.py', start: 1 }, posix)).toMatchObject({ path: '/home/dev/app/views.py' });
    expect(openMessage(root, { path: '/etc/passwd', start: 1 }, posix)).toBeUndefined();
    // with this machine's rules on Windows the same request would become a C:\ path
    expect(openMessage('C:\\work\\shop', { path: 'app/models.py', start: 1 }, win32)).toMatchObject({ path: 'C:\\work\\shop\\app\\models.py' });
});

test('Open in VS Code opens a remote repo through its vscode-remote URI', () => {
    const ssh = { kind: 'ssh' as const, host: 'shop', path: '~/shop' };
    expect(vscodeUriAt(ssh, '/home/dev/shop')).toBe('vscode-remote://ssh-remote+shop/home/dev/shop');
    expect(vscodeUriAt({ kind: 'container', folder: '/work/shop' }, '/workspaces/shop/a.appling')).toMatch(/^vscode-remote:\/\/dev-container\+[0-9a-f]+\/workspaces\/shop\/a\.appling$/);
    expect(vscodeRemoteArgs('vscode-remote://ssh-remote+shop/home/dev/shop')).toEqual(['--folder-uri', 'vscode-remote://ssh-remote+shop/home/dev/shop']);
    expect(vscodeRemoteArgs('vscode-remote://ssh-remote+shop/r', 'vscode-remote://ssh-remote+shop/r/a.appling')).toEqual(['--folder-uri', 'vscode-remote://ssh-remote+shop/r', '--file-uri', 'vscode-remote://ssh-remote+shop/r/a.appling']);
});

test('code view settings read the codeView section and report bad values', () => {
    const dir = temp();
    const file = join(dir, 'settings.json');
    expect(loadCodeViewSettings(file)).toEqual({ settings: DEFAULT_CODE_VIEW, problems: [] });
    writeFileSync(file, JSON.stringify({ terminal: {}, codeView: { lifecycle: 'always', idleMinutes: 2, width: 0.4 } }));
    expect(loadCodeViewSettings(file)).toEqual({ settings: { lifecycle: 'always', idleMinutes: 2, width: 0.4 }, problems: [] });
    writeFileSync(file, JSON.stringify({ codeView: { lifecycle: 'sometimes', idleMinutes: 0, width: 1, colour: 'red' } }));
    const { settings, problems } = loadCodeViewSettings(file);
    expect(settings).toEqual(DEFAULT_CODE_VIEW);
    expect(problems).toHaveLength(4);
    writeFileSync(file, '{');
    expect(loadCodeViewSettings(file).problems[0]).toContain(file);
});

test('the code view takes its share on the right of the repo; hidden, the IDE fills it', () => {
    const area = { x: 48, y: 0, width: 1000, height: 800 };
    expect(splitBounds(area, false, 0.5)).toEqual({ ide: area });
    expect(splitBounds(area, true, 0.4)).toEqual({ ide: { x: 48, y: 0, width: 600, height: 800 }, code: { x: 648, y: 0, width: 400, height: 800 } });
});

test('instances get stable keys, local only arguments and the port from the log', () => {
    expect(repoKey('/work/shop')).toBe(repoKey('/work/shop'));
    expect(repoKey('/work/shop')).toMatch(/^[0-9a-f]{16}$/);
    expect(repoKey('/work/crm')).not.toBe(repoKey('/work/shop'));
    const dirs = codeDirs('/data/code-oss');
    expect(dirs).toEqual({ userDataDir: '/data/code-oss/user-data', extensionsDir: '/data/code-oss/extensions', serverDataDir: '/data/code-oss/server-data' });
    const args = codeServerArgs({ binary: 'x', key: 'k', ...dirs }, '/t/k');
    expect(args.join(' ')).toContain('--host 127.0.0.1 --port 0 --connection-token-file /t/k --server-base-path /r/k');
    expect(args).toContain('--accept-server-license-terms');
    expect(boundPort('Server bound to 127.0.0.1:37471 (IPv4)\nExtension host agent listening on 37471')).toBe(37471);
    expect(boundPort('starting')).toBeUndefined();
});

test('Open in VS Code finds the code command and opens the repo or a file at its line', () => {
    const exists = (path: string) => path === '/opt/vs/bin/code';
    expect(findCode({ PATH: '/usr/x:/opt/vs/bin' }, 'linux', exists)).toBe('/opt/vs/bin/code');
    expect(findCode({ PATH: '/usr/x' }, 'linux', exists)).toBeUndefined();
    expect(findCode({ PATH: '' }, 'darwin', path => path.startsWith('/Applications/'))).toContain('Visual Studio Code.app');
    expect(lineColumn('ab\ncd\nef', 4)).toEqual({ line: 2, column: 2 });
    expect(lineColumn('ab', 0)).toEqual({ line: 1, column: 1 });
    expect(vscodeArgs('/r')).toEqual(['/r']);
    expect(vscodeArgs('/r', { path: '/r/a.appling', line: 3, column: 7 })).toEqual(['/r', '--goto', '/r/a.appling:3:7']);
    expect(vscodeArgs('/r', { path: '/r/a.appling' })).toEqual(['/r', '--goto', '/r/a.appling']);
    expect(DEFAULT_KEYBINDINGS.toggleCode).toBe('CmdOrCtrl+Alt+C');
});

/**
 * The real openvscode-server: downloaded (about 75 MB, once) into `node_modules/.cache`, with the Appling extension
 * installed, started headless and reached through the proxy. Runs when the server is cached or when
 * `APPLING_CODE_SERVER_TEST=1` allows the download, on Linux only.
 */
const CACHE = resolve(fileURLToPath(new URL('../node_modules/.cache/code-server', import.meta.url)));
const VSIX = resolve(fileURLToPath(new URL('../../vscode/out/appling.vsix', import.meta.url)));
const asset = codeServerAsset(process.platform, process.arch);
const realServer = !!asset && (existsSync(join(CACHE, asset.name)) || process.env.APPLING_CODE_SERVER_TEST === '1');

test.skipIf(!realServer)('a real Code OSS instance starts headless with the Appling extension and answers through the proxy', async () => {
    const binary = await ensureCodeServer(CACHE);
    const dirs = codeDirs(temp());
    if (existsSync(VSIX)) {
        await installExtension(binary, VSIX, dirs);
        const listed = execFileSync(binary, ['--list-extensions', '--extensions-dir', dirs.extensionsDir, '--user-data-dir', dirs.userDataDir, '--server-data-dir', dirs.serverDataDir], { encoding: 'utf8' });
        expect(listed).toContain('techthos.appling-vscode');
    }
    const key = repoKey('/repo');
    const server: CodeServer = await startCodeServer({ binary, key, ...dirs, timeout: 60000 });
    cleanup.push(() => server.close());
    expect((await get(`http://127.0.0.1:${server.port}/r/${key}/`)).status).toBe(403);

    const proxy = new CodeProxy({ secret: 's' });
    await proxy.listen();
    cleanup.push(() => proxy.close());
    proxy.route(key, { port: server.port, token: server.token });
    const page = await get(proxy.url(key, temp()), { cookie: `${PROXY_COOKIE}=s` });
    expect(page.status).toBe(200);
    expect(page.body).toContain('workbench.js');
    expect(page.body).toContain(`&quot;serverBasePath&quot;:&quot;/r/${key}&quot;`);
    expect(page.headers['set-cookie']).toBeUndefined();
    await server.close();
    expect(server.child.exitCode !== null || server.child.signalCode !== null).toBe(true);
}, 240000);


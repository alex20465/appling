// Starts one UI sandbox in the foreground for an agent to see and use through the `sandbox` MCP server of .mcp.json
// (Playwright over Chrome DevTools at 127.0.0.1:9222, so one sandbox runs at a time). Every start copies examples/
// into .sandbox/workspace as a git repo with one commit: the Review tab has a base and the agent's edits never reach
// examples/. Each target keeps its own profile under .sandbox/<target>, apart from the user's editors and app data.
// Usage: node scripts/sandbox/start.mjs <inspect|openvscode|vscode>   (pnpm sandbox <target>, make sandbox ARGS=<target>)
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const sandbox = join(root, '.sandbox');
const workspace = join(sandbox, 'workspace');
const cdp = 9222;
const target = process.argv[2];

const builds = {
    inspect: ['packages/inspect/out/server/main.js', 'packages/inspect/dist/client/index.html'],
    openvscode: ['packages/vscode/out/appling.vsix'],
    vscode: ['packages/vscode/out/extension/extension.js']
};
if (!builds[target]) {
    console.error('Usage: node scripts/sandbox/start.mjs <inspect|openvscode|vscode>');
    process.exit(2);
}
const missing = builds[target].filter(file => !existsSync(join(root, file)));
if (missing.length) {
    console.error(`Not built: ${missing.join(', ')}. Run pnpm build first.`);
    process.exit(1);
}

rmSync(workspace, { recursive: true, force: true });
cpSync(join(root, 'examples'), workspace, { recursive: true });
const git = (...args) => spawnSync('git', ['-c', 'user.name=sandbox', '-c', 'user.email=sandbox@localhost', '-c', 'commit.gpgsign=false', ...args], { cwd: workspace, stdio: 'ignore' });
git('init', '-q');
git('add', '.');
git('commit', '-q', '-m', 'sandbox base');

const children = [];
function run(command, args, options = {}) {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('exit', () => stop());
    children.push(child);
    return child;
}
function stop() {
    for (const child of children) if (child.exitCode === null) child.kill();
    process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

async function reachable(url) {
    for (let tries = 0; tries < 120; tries++) {
        if (await fetch(url).then(() => true, () => false)) return;
        await new Promise(done => setTimeout(done, 500));
    }
    throw new Error(`${url} did not answer within a minute.`);
}

function chrome(url) {
    const binary = process.env.CHROME ?? ['google-chrome', 'chromium', 'chromium-browser']
        .find(name => spawnSync('which', [name], { stdio: 'ignore' }).status === 0);
    if (!binary) throw new Error('No Chrome or Chromium on the PATH; set CHROME to its binary.');
    run(binary, [`--user-data-dir=${join(sandbox, 'chrome')}`, `--remote-debugging-port=${cdp}`, '--no-first-run',
        '--no-default-browser-check', '--window-size=1600,1000', `--app=${url}`], { stdio: 'ignore' });
}

if (target === 'inspect') {
    run(process.execPath, [join(root, 'packages/inspect/out/server/main.js'), workspace, '--port', '4410']);
    await reachable('http://127.0.0.1:4410/');
    chrome('http://127.0.0.1:4410/');
}

// the pinned openvscode-server (Linux builds only), its archive verified against GitHub's SHA-256 of the release asset
const CODE_SERVER = {
    version: '1.109.5',
    sha256: {
        'linux-x64': 'b433bf4f0227321a7014d8460d10a8f958adc0f45aa79bd889e84e65e8f88363',
        'linux-arm64': '36d9c14036489b63de84ebace837fcacf7e60e669a0dc715802c5443684ea4dc',
        'linux-armhf': 'f84ac0dcea0bdeac07e172e58903b38bc5ef0ac94b0bf2ab2ce4eca325ab98bb'
    }
};

async function codeServer(cache) {
    const key = `${process.platform}-${{ arm: 'armhf' }[process.arch] ?? process.arch}`;
    const sha256 = CODE_SERVER.sha256[key];
    if (!sha256) throw new Error(`openvscode-server has no build for ${key}.`);
    const name = `openvscode-server-v${CODE_SERVER.version}-${key}`;
    const binary = join(cache, name, 'bin/openvscode-server');
    if (existsSync(binary)) return binary;
    console.log('Fetching openvscode-server once into .sandbox/cache…');
    const response = await fetch(`https://github.com/gitpod-io/openvscode-server/releases/download/openvscode-server-v${CODE_SERVER.version}/${name}.tar.gz`);
    if (!response.ok) throw new Error(`Downloading ${name}.tar.gz failed: ${response.status}`);
    const archive = Buffer.from(await response.arrayBuffer());
    const digest = createHash('sha256').update(archive).digest('hex');
    if (digest !== sha256) throw new Error(`${name}.tar.gz has SHA-256 ${digest}, expected ${sha256}.`);
    mkdirSync(cache, { recursive: true });
    if (spawnSync('tar', ['-xz', '-C', cache], { input: archive }).status !== 0) throw new Error(`Unpacking ${name}.tar.gz failed.`);
    return binary;
}

if (target === 'openvscode') {
    const binary = await codeServer(join(sandbox, 'cache'));
    const dirs = ['--user-data-dir', join(sandbox, 'openvscode/user-data'), '--extensions-dir', join(sandbox, 'openvscode/extensions'),
        '--server-data-dir', join(sandbox, 'openvscode/server-data')];
    spawnSync(binary, [...dirs, '--install-extension', join(root, 'packages/vscode/out/appling.vsix'), '--force'], { stdio: 'inherit' });
    run(binary, [...dirs, '--host', '127.0.0.1', '--port', '4411', '--without-connection-token', '--accept-server-license-terms', '--telemetry-level', 'off']);
    await reachable('http://127.0.0.1:4411/');
    chrome(`http://127.0.0.1:4411/?folder=${encodeURIComponent(workspace)}`);
}

if (target === 'vscode') {
    const user = join(sandbox, 'vscode/user-data');
    mkdirSync(join(user, 'User'), { recursive: true });
    writeFileSync(join(user, 'User/settings.json'), JSON.stringify({
        'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false, 'telemetry.telemetryLevel': 'off', 'update.mode': 'none'
    }, null, 2));
    run(process.env.CODE ?? 'code', ['--wait', '--new-window', '--user-data-dir', user, '--extensions-dir', join(sandbox, 'vscode/extensions'),
        '--extensionDevelopmentPath', join(root, 'packages/vscode'), `--remote-debugging-port=${cdp}`, workspace]);
}

console.log(`Sandbox ${target} on ${workspace}, DevTools at http://127.0.0.1:${cdp}. Ctrl+C ends it.`);

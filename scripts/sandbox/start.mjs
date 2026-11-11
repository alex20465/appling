// Starts one UI sandbox in the foreground for an agent to see and use through the `sandbox` MCP server of .mcp.json
// (Playwright over Chrome DevTools at 127.0.0.1:9222, so one sandbox runs at a time). Every start copies examples/
// into .sandbox/workspace as a git repo with one commit: the Review tab has a base and the agent's edits never reach
// examples/. Each target keeps its own profile under .sandbox/<target>, apart from the user's editors and app data.
// Usage: node scripts/sandbox/start.mjs <ide|openvscode|vscode|desktop>   (pnpm sandbox <target>, make sandbox ARGS=<target>)
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const sandbox = join(root, '.sandbox');
const workspace = join(sandbox, 'workspace');
const cdp = 9222;
const target = process.argv[2];

const builds = {
    ide: ['packages/ide/out/server/main.js', 'packages/ide/dist/client/index.html'],
    openvscode: ['packages/vscode/out/appling.vsix', 'packages/desktop/out/code-download.js'],
    vscode: ['packages/vscode/out/extension/extension.js'],
    desktop: ['packages/desktop/out/main.js']
};
if (!builds[target]) {
    console.error('Usage: node scripts/sandbox/start.mjs <ide|openvscode|vscode|desktop>');
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

if (target === 'ide') {
    run(process.execPath, [join(root, 'packages/ide/out/server/main.js'), workspace, '--port', '4410']);
    await reachable('http://127.0.0.1:4410/');
    chrome('http://127.0.0.1:4410/');
}

if (target === 'openvscode') {
    const { ensureCodeServer } = await import(join(root, 'packages/desktop/out/code-download.js'));
    console.log('Fetching openvscode-server once into .sandbox/cache…');
    const binary = await ensureCodeServer(join(sandbox, 'cache'));
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

if (target === 'desktop') {
    const electron = createRequire(join(root, 'packages/desktop/package.json'))('electron');
    const env = { ...process.env, APPLING_PTY_HOST_DIR: join(sandbox, 'desktop/pty') };
    delete env.ELECTRON_RUN_AS_NODE;
    // the code view reuses the openvscode-server of the openvscode sandbox instead of downloading its own
    const { codeServerAsset, codeServerBinary } = await import(join(root, 'packages/desktop/out/code-download.js'));
    const asset = codeServerAsset(process.platform, process.arch);
    if (asset && existsSync(codeServerBinary(join(sandbox, 'cache'), asset))) env.APPLING_CODE_SERVER = codeServerBinary(join(sandbox, 'cache'), asset);
    run(electron, [`--remote-debugging-port=${cdp}`, `--user-data-dir=${join(sandbox, 'desktop/user-data')}`,
        join(root, 'packages/desktop/out/main.js'), '--', workspace], { env });
}

console.log(`Sandbox ${target} on ${workspace}, DevTools at http://127.0.0.1:${cdp}. Ctrl+C ends it.`);

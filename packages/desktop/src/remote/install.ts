import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { codeServerAsset, type CodeServerAsset } from '../code-download.js';
import { shellQuote, type AgentCommand, type Transport } from './transport.js';

/** The folder in the remote user's home that holds every installed server, as VS Code's `~/.vscode-server`. */
export const SERVER_ROOT = '.appling-server';

/**
 * What the server bundle holds, a part of the packaged app (`scripts/bundle.mjs`): the IDE server with its client,
 * the pty host with node-pty, the agent and the Appling extension for Code OSS. The Node binary and Code OSS come
 * separately, per platform of the other machine.
 */
export const BUNDLE_PARTS = ['package.json', 'ide', 'pty-host', 'native', 'remote', 'vscode', 'cli'];

/** The app folder that holds the server bundle: the packaged app's root, else `packages/desktop/app` after `pnpm --filter @appling/desktop bundle`. */
export function serverBundle(base: string = dirname(dirname(dirname(fileURLToPath(import.meta.url))))): string {
    for (const dir of [base, join(base, 'app')]) if (existsSync(join(dir, 'remote', 'agent.js'))) return dir;
    throw new Error(`Remote repos need the server bundle, which ${join(base, 'app')} does not hold; run pnpm --filter @appling/desktop bundle.`);
}

/** The bundle's version: the app's version and a digest of its files, so a changed build installs again. */
export function bundleVersion(app: string): string {
    const hash = createHash('sha256');
    const walk = (path: string) => {
        const stat = statSync(path);
        if (stat.isDirectory()) for (const entry of readdirSync(path).sort()) walk(join(path, entry));
        else hash.update(`${path.slice(app.length)}\0${stat.size}\0`).update(readFileSync(path));
    };
    for (const part of BUNDLE_PARTS) if (existsSync(join(app, part))) walk(join(app, part));
    const version = (JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0';
    return `${version}-${hash.digest('hex').slice(0, 12)}`;
}

/** A platform as Node names it: `linux-x64`, `darwin-arm64`. */
export interface Platform {
    platform: 'linux' | 'darwin';
    arch: 'x64' | 'arm64' | 'armv7l';
}

/** The platform from `uname -sm` (`Linux x86_64`, `Darwin arm64`, `Linux aarch64`). Throws for others. */
export function parseUname(output: string): Platform {
    const [system = '', machine = ''] = output.trim().split(/\s+/);
    const platform = system === 'Linux' ? 'linux' : system === 'Darwin' ? 'darwin' : undefined;
    const arch = /^(x86_64|amd64)$/.test(machine) ? 'x64' : /^(aarch64|arm64)$/.test(machine) ? 'arm64' : /^armv[78]/.test(machine) ? 'armv7l' : undefined;
    if (!platform || !arch) throw new Error(`Remote repos need Linux or macOS on x64 or arm64, not ${output.trim()}.`);
    return { platform, arch };
}

/** What the probe found on the other side. */
export interface Probe extends Platform {
    home: string;
    /** The install folder: `$APPLING_SERVER_ROOT` there, else `~/.appling-server`. */
    root: string;
    /** musl based (Alpine), where the official Node builds do not run. */
    musl: boolean;
    /** Installed already: the bundle of this version, the Node binary, Code OSS. */
    bundle: boolean;
    node: boolean;
    code: boolean;
}

/** The folders of one install on the other side. */
export interface Layout {
    root: string;
    /** The bundle of this version: `<root>/<version>`. */
    server: string;
    /** The Node binary, per Node version and platform. */
    node: string;
    /** Code OSS, per release. */
    code: string;
}

export function layout(root: string, version: string, nodeVersion: string, platform: Platform, codeName?: string): Layout {
    const base = root.replace(/\/+$/, '');
    return {
        root: base,
        server: `${base}/${version}`,
        node: `${base}/node/v${nodeVersion}-${platform.platform}-${platform.arch}/bin/node`,
        code: `${base}/code/${codeName ?? 'none'}`
    };
}

/** A script that prints what `parseProbe` reads: the platform, the home and install folders, the libc and what is installed. */
export function probeScript(version: string, nodeVersion: string, codeName?: string): string {
    return [
        `R="\${APPLING_SERVER_ROOT:-$HOME/${SERVER_ROOT}}"`,
        'uname -sm',
        'printf "%s\\n" "$HOME" "$R"',
        '(ldd --version 2>&1 || true) | grep -qi musl && echo musl || echo glibc',
        `test -f "$R"/${shellQuote(version)}/.installed && echo bundle || echo -`,
        `ls -d "$R"/node/v${shellQuote(nodeVersion)}-*/bin/node 2>/dev/null | head -n 1 | grep -q . && echo node || echo -`,
        `test -x "$R"/code/${shellQuote(codeName ?? 'none')}/bin/openvscode-server && echo code || echo -`
    ].join('; ');
}

export function parseProbe(output: string): Probe {
    const [uname = '', home = '', root = '', libc = '', bundle = '', node = '', code = ''] = output.trim().split('\n').map(l => l.trim());
    if (!home.startsWith('/') || !root.startsWith('/')) throw new Error(`The probe found no home folder: ${output.trim()}`);
    return { ...parseUname(uname), home, root, musl: libc === 'musl', bundle: bundle === 'bundle', node: node === 'node', code: code === 'code' };
}

/** One step of an install: a stream that goes into a script there. */
export interface InstallStep {
    what: 'bundle' | 'node' | 'code';
    /** Unpacks the stream into a temporary folder, then moves it into place, so a broken upload leaves nothing half done. */
    script: string;
}

/** The script that unpacks a `.tar.gz` from stdin into `target` atomically (`strip` leading folders, only `members` when given). */
export function unpackScript(target: string, options: { strip?: number, members?: string[], marker?: string } = {}): string {
    const q = shellQuote(target);
    const partial = shellQuote(`${target}.partial`);
    return [
        'set -e',
        `mkdir -p ${shellQuote(dirname(target))}`,
        `rm -rf ${partial}.$$ && mkdir -p ${partial}.$$`,
        `tar -xzf - -C ${partial}.$$${options.strip ? ` --strip-components=${options.strip}` : ''}${options.members?.length ? ` ${options.members.map(shellQuote).join(' ')}` : ''}`,
        ...options.marker ? [`touch ${partial}.$$/${shellQuote(options.marker)}`] : [],
        // another install that won the race keeps its folder
        `if [ -e ${q} ]; then rm -rf ${partial}.$$; else mv ${partial}.$$ ${q}; fi`
    ].join('\n');
}

/** The Node release archive of a platform, from nodejs.org. */
export function nodeAsset(version: string, platform: Platform): { name: string, url: string, sums: string } {
    const name = `node-v${version}-${platform.platform}-${platform.arch}`;
    return { name, url: `https://nodejs.org/dist/v${version}/${name}.tar.gz`, sums: `https://nodejs.org/dist/v${version}/SHASUMS256.txt` };
}

/** The digest of a file in a SHASUMS256.txt. */
export function shaFromSums(sums: string, file: string): string | undefined {
    return sums.split('\n').map(line => line.trim().split(/\s+/)).find(([, name]) => name === file)?.[0];
}

/** The plan of an install: what is missing. Throws when the other side cannot run the server. */
export function installPlan(probe: Probe, paths: Layout, options: { code?: boolean, nodeVersion: string }): InstallStep[] {
    if (probe.musl) throw new Error('Remote repos need a glibc based Linux; musl (Alpine) is not supported yet.');
    const steps: InstallStep[] = [];
    // only the binary of the release archive (`node-v<version>-<platform>/bin/node`)
    const node = nodeAsset(options.nodeVersion, probe).name;
    if (!probe.node) steps.push({ what: 'node', script: unpackScript(dirname(dirname(paths.node)), { strip: 1, members: [`${node}/bin/node`] }) });
    if (!probe.bundle) steps.push({ what: 'bundle', script: unpackScript(paths.server, { marker: '.installed' }) });
    if (options.code && !probe.code) steps.push({ what: 'code', script: unpackScript(paths.code, { strip: 1 }) });
    return steps;
}

/** Whether the bundle's node-pty has native files for the platform (a local build of this platform, or a prebuild). */
export function hasNativePty(app: string, platform: Platform, local: Platform | { platform: string, arch: string } = { platform: process.platform, arch: process.arch }): boolean {
    const native = join(app, 'native', 'node-pty');
    if (existsSync(join(native, 'prebuilds', `${platform.platform}-${platform.arch}`))) return true;
    return existsSync(join(native, 'build', 'Release')) && local.platform === platform.platform && local.arch === platform.arch;
}

export interface InstallOptions {
    /** The app folder with the server bundle (`serverBundle()`). */
    app: string;
    /** Where downloads are kept (the Node and Code OSS archives per platform). */
    cache: string;
    /** The Node version to run there; this process's by default. */
    nodeVersion?: string;
    /** A Node binary to upload instead of downloading one, when it runs on the other side's platform (tests, offline use). */
    node?: string;
    /** Also install Code OSS (when the code view opens). */
    code?: boolean;
    onProgress?(line: string): void;
}

export interface Installed {
    probe: Probe;
    paths: Layout;
    agent: AgentCommand;
    version: string;
    /** Whether the pty host can run there (node-pty has native files for the platform). */
    terminals: boolean;
}

const versions = new Map<string, string>();

/**
 * Installs the server once per machine and version, the way VS Code's remote server installs: the probe says what is
 * there, missing parts are uploaded as `.tar.gz` streams over the transport (no internet access needed there) and
 * unpacked atomically. Node and Code OSS are downloaded here once per platform and checked against their digests.
 * Sets the transport's agent.
 */
export async function install(transport: Transport, options: InstallOptions): Promise<Installed> {
    const version = versions.get(options.app) ?? bundleVersion(options.app);
    versions.set(options.app, version);
    const nodeVersion = options.nodeVersion ?? process.versions.node;
    // the platform first, for the name of its Code OSS release
    const uname = await transport.exec('uname -sm', { timeout: 60000 });
    if (uname.code !== 0) throw new Error(`Running a command on ${transport.label} failed: ${uname.stderr.trim() || `exit code ${uname.code}`}`);
    const platform = parseUname(uname.stdout);
    const asset = codeServerAsset(platform.platform, platform.arch === 'armv7l' ? 'arm' : platform.arch);
    const probed = await transport.exec(probeScript(version, nodeVersion, asset?.name), { timeout: 60000 });
    if (probed.code !== 0) throw new Error(`The probe on ${transport.label} failed: ${probed.stderr.trim() || `exit code ${probed.code}`}`);
    const probe = parseProbe(probed.stdout);
    const paths = layout(probe.root, version, nodeVersion, probe, asset?.name);
    if (options.code && !asset) throw new Error(`openvscode-server has no build for ${probe.platform}-${probe.arch}.`);
    for (const step of installPlan(probe, paths, { code: options.code, nodeVersion })) {
        options.onProgress?.(`Installing ${step.what === 'bundle' ? 'the Appling server' : step.what === 'node' ? 'Node' : 'Code OSS'} on ${transport.label}…`);
        const input = step.what === 'bundle' ? tarStream(options.app, BUNDLE_PARTS.filter(p => existsSync(join(options.app, p))))
            : step.what === 'node' ? await nodeArchive(options, nodeVersion, probe)
            : createReadStream(await download(asset!.url, asset!.sha256, join(options.cache, `${asset!.name}.tar.gz`)));
        const result = await transport.exec(step.script, { input });
        if (result.code !== 0) throw new Error(`Installing ${step.what} on ${transport.label} failed: ${result.stderr.trim() || `exit code ${result.code}`}`);
    }
    const agent = { node: paths.node, agent: `${paths.server}/remote/agent.js` };
    transport.agent = agent;
    return { probe, paths, agent, version, terminals: hasNativePty(options.app, probe) };
}

/** Packs folders into a `.tar.gz` stream with the system's tar (also on Windows 10 and later). */
export function tarStream(dir: string, entries: string[]): Readable {
    const tar = spawn('tar', ['-czf', '-', '-C', dir, ...entries], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    tar.stderr.resume();
    return tar.stdout;
}

/** The Node archive for the other side: a given binary packed as `<x>/bin/node`, else the release archive with only its binary. */
async function nodeArchive(options: InstallOptions, version: string, platform: Platform): Promise<Readable> {
    if (options.node) {
        const { name } = nodeAsset(version, platform);
        const temp = join(options.cache, `node-upload-${process.pid}`);
        rmSync(temp, { recursive: true, force: true });
        mkdirSync(join(temp, name, 'bin'), { recursive: true });
        copyFileSync(options.node, join(temp, name, 'bin', 'node'));
        chmodSync(join(temp, name, 'bin', 'node'), 0o755);
        const stream = tarStream(temp, [name]);
        stream.once('close', () => rmSync(temp, { recursive: true, force: true }));
        return stream;
    }
    const asset = nodeAsset(version, platform);
    const sums = await (await fetch(asset.sums)).text();
    const sha = shaFromSums(sums, `${asset.name}.tar.gz`);
    if (!sha) throw new Error(`nodejs.org lists no ${asset.name}.tar.gz.`);
    return createReadStream(await download(asset.url, sha, join(options.cache, `${asset.name}.tar.gz`)));
}

/** Downloads a file once into the cache, checking its SHA-256; a file that does not match is not kept. */
export async function download(url: string, sha256: string, file: string): Promise<string> {
    if (existsSync(file)) return file;
    mkdirSync(dirname(file), { recursive: true });
    const partial = `${file}.${process.pid}.partial`;
    try {
        const response = await fetch(url);
        if (!response.ok || !response.body) throw new Error(`Downloading ${url} failed: ${response.status} ${response.statusText}`);
        const hash = createHash('sha256');
        const out = createWriteStream(partial);
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
            hash.update(chunk);
            if (!out.write(chunk)) await new Promise<void>(resolve => out.once('drain', () => resolve()));
        }
        await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => error ? reject(error) : resolve()));
        const digest = hash.digest('hex');
        if (digest !== sha256) throw new Error(`${basename(url)} has SHA-256 ${digest}, expected ${sha256}; it was not used.`);
        renameSync(partial, file);
        return file;
    } finally {
        rmSync(partial, { force: true });
    }
}

export type { CodeServerAsset };

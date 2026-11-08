import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** A pinned openvscode-server release: its version and the SHA-256 of each platform's archive. */
export interface CodeServerRelease {
    version: string;
    /** Where the archives are; `{version}` and `{asset}` are filled in. */
    url: string;
    /** By `<platform>-<arch>` as openvscode-server names them. */
    sha256: Record<string, string>;
}

/**
 * The openvscode-server the app uses, pinned so every install runs the same Code OSS; its archives are verified
 * against these digests (GitHub's own for the release assets). openvscode-server publishes Linux builds only.
 */
export const CODE_SERVER: CodeServerRelease = {
    version: '1.109.5',
    url: 'https://github.com/gitpod-io/openvscode-server/releases/download/openvscode-server-v{version}/{asset}',
    sha256: {
        'linux-x64': 'b433bf4f0227321a7014d8460d10a8f958adc0f45aa79bd889e84e65e8f88363',
        'linux-arm64': '36d9c14036489b63de84ebace837fcacf7e60e669a0dc715802c5443684ea4dc',
        'linux-armhf': 'f84ac0dcea0bdeac07e172e58903b38bc5ef0ac94b0bf2ab2ce4eca325ab98bb'
    }
};

export interface CodeServerAsset {
    /** The folder the archive unpacks into, `openvscode-server-v<version>-<platform>-<arch>`. */
    name: string;
    url: string;
    sha256: string;
}

const ARCH: Record<string, string> = { x64: 'x64', arm64: 'arm64', arm: 'armhf' };

/** The archive for a platform (`process.platform`, `process.arch`); undefined where there is no build. */
export function codeServerAsset(platform: string, arch: string, release = CODE_SERVER): CodeServerAsset | undefined {
    const key = `${platform}-${ARCH[arch] ?? arch}`;
    const sha256 = release.sha256[key];
    if (!sha256) return undefined;
    const name = `openvscode-server-v${release.version}-${key}`;
    return { name, sha256, url: release.url.replace('{version}', release.version).replace('{asset}', `${name}.tar.gz`) };
}

/** The server's launcher inside the cache. */
export function codeServerBinary(cache: string, asset: CodeServerAsset): string {
    return join(cache, asset.name, 'bin', 'openvscode-server');
}

export interface EnsureOptions {
    platform?: string;
    arch?: string;
    release?: CodeServerRelease;
    /** Bytes received and the total (0 when unknown). */
    onProgress?(received: number, total: number): void;
}

const pending = new Map<string, Promise<string>>();

/**
 * The launcher of the pinned openvscode-server, downloaded on first use into the cache folder: the archive goes to a
 * temporary file while its digest is computed, is rejected unless it matches, and is unpacked into a temporary folder
 * that is renamed into place, so the cache never holds a partial server; servers of earlier pins are removed then. Concurrent calls share one download.
 */
export function ensureCodeServer(cache: string, options: EnsureOptions = {}): Promise<string> {
    const platform = options.platform ?? process.platform;
    const arch = options.arch ?? process.arch;
    const asset = codeServerAsset(platform, arch, options.release);
    if (!asset) return Promise.reject(new Error(`openvscode-server has no build for ${platform}-${arch}; the code view needs Linux on x64, arm64 or armhf.`));
    const binary = codeServerBinary(cache, asset);
    if (existsSync(binary)) return Promise.resolve(binary);
    const running = pending.get(binary);
    if (running) return running;
    const download = fetchServer(cache, asset, options).then(() => binary).finally(() => pending.delete(binary));
    pending.set(binary, download);
    return download;
}

async function fetchServer(cache: string, asset: CodeServerAsset, options: EnsureOptions): Promise<void> {
    mkdirSync(cache, { recursive: true });
    const temp = mkdtempSync(join(cache, '.download-'));
    try {
        const archive = join(temp, `${asset.name}.tar.gz`);
        const response = await fetch(asset.url);
        if (!response.ok || !response.body) throw new Error(`Downloading ${asset.url} failed: ${response.status} ${response.statusText}`);
        const total = Number(response.headers.get('content-length') ?? 0);
        const hash = createHash('sha256');
        const file = createWriteStream(archive);
        let received = 0;
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
            hash.update(chunk);
            received += chunk.length;
            if (!file.write(chunk)) await new Promise<void>(resolve => file.once('drain', () => resolve()));
            options.onProgress?.(received, total);
        }
        await new Promise<void>((resolve, reject) => file.end((error?: Error | null) => error ? reject(error) : resolve()));
        const digest = hash.digest('hex');
        if (digest !== asset.sha256) throw new Error(`${asset.name}.tar.gz has SHA-256 ${digest}, expected ${asset.sha256}; it was not installed.`);
        const unpacked = join(temp, 'unpacked');
        mkdirSync(unpacked);
        await untar(archive, unpacked);
        if (!existsSync(join(unpacked, asset.name, 'bin', 'openvscode-server'))) throw new Error(`${asset.name}.tar.gz holds no ${asset.name}/bin/openvscode-server.`);
        renameSync(join(unpacked, asset.name), join(cache, asset.name));
        // servers of earlier pins are no longer used
        for (const entry of readdirSync(cache)) {
            if (entry.startsWith('openvscode-server-v') && entry !== asset.name) rmSync(join(cache, entry), { recursive: true, force: true });
        }
    } finally {
        rmSync(temp, { recursive: true, force: true });
    }
}

function untar(archive: string, into: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const tar = spawn('tar', ['-xzf', archive, '-C', into], { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        tar.stderr.on('data', chunk => stderr += chunk);
        tar.once('error', reject);
        tar.once('exit', code => code === 0 ? resolve() : reject(new Error(`tar ended with code ${code}: ${stderr.trim()}`)));
    });
}

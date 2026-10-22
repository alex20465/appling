import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Graph } from './graph.js';

export interface Release {
    version: string;
    created: string;
    graph: Graph;
}

const VERSION = /^\d+\.\d+\.\d+$/;

export function releasesDir(root: string): string {
    return join(root, '.appling', 'releases');
}

export function readReleases(root: string): Release[] {
    const dir = releasesDir(root);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Release);
}

/** Writes a release snapshot and returns its path. Throws for an invalid or existing version. */
export function writeRelease(root: string, version: string, graph: Graph): string {
    if (!VERSION.test(version)) throw new Error(`Version must look like 1.2.3, got "${version}".`);
    const file = join(releasesDir(root), `${version}.json`);
    if (existsSync(file)) throw new Error(`Release ${version} already exists.`);
    mkdirSync(releasesDir(root), { recursive: true });
    const release: Release = { version, created: new Date().toISOString(), graph };
    writeFileSync(file, JSON.stringify(release, null, 2) + '\n');
    return file;
}

export function latestRelease(releases: Release[]): Release | undefined {
    return [...releases].sort((a, b) => compareVersions(b.version, a.version))[0];
}

/** The migration block that collects the steps made after a release, such as `since_v1_0_0`. */
export function migrationBlockName(version: string): string {
    return `since_v${version.replaceAll('.', '_')}`;
}

function compareVersions(a: string, b: string): number {
    const [x, y] = [a.split('.').map(Number), b.split('.').map(Number)];
    return x.map((part, i) => part - y[i]).find(d => d !== 0) ?? 0;
}

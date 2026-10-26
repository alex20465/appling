import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { URI } from 'langium';
import { findApplingFiles, resolveReferences } from '@appling/model';
import { buildSnapshot } from '../shared/model.js';
import type { CodeLocation, Snapshot, ViewSettings } from '../shared/snapshot.js';

export async function snapshot(root: string): Promise<Snapshot> {
    const files = findApplingFiles(root).map(path => ({ uri: URI.file(path).toString(), path: relative(root, path), text: readFileSync(path, 'utf8') }));
    const snapshot = await buildSnapshot(URI.file(root).toString(), files);
    const code = Object.groupBy(resolveReferences(root, snapshot.graph).map(r => ({
        ...r, text: r.status === 'broken' ? '' : readFileSync(resolve(root, r.file), 'utf8').split('\n').slice(r.start - 1, r.end).join('\n')
    })), r => r.qn) as Record<string, CodeLocation[]>;
    return { ...snapshot, code };
}

const VIEW = join('.appling', 'view.json');

/** The canvas settings, kept outside the model so they never appear in model diffs. */
export function readView(root: string): Partial<ViewSettings> {
    const file = join(root, VIEW);
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
}

export function writeView(root: string, view: ViewSettings): void {
    const file = join(root, VIEW);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(view, null, 2) + '\n');
}

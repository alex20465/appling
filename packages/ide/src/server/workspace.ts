import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { URI } from 'langium';
import { workspaceImplementation } from '@appling/codegen';
import { findApplingFiles, lineMarks, resolveReferences, type LineMark } from '@appling/model';
import { buildSnapshot } from '../shared/model.js';
import type { CodeLocation, Snapshot, ViewSettings } from '../shared/snapshot.js';

export async function snapshot(root: string): Promise<Snapshot> {
    const files = findApplingFiles(root).map(path => ({ uri: URI.file(path).toString(), path: relative(root, path), text: readFileSync(path, 'utf8') }));
    const snapshot = await buildSnapshot(URI.file(root).toString(), files);
    const code = Object.groupBy(resolveReferences(root, snapshot.graph).map(r => ({
        ...r, text: r.status === 'broken' || !existsSync(resolve(root, r.file)) ? '' : readFileSync(resolve(root, r.file), 'utf8').split('\n').slice(r.start - 1, r.end).join('\n')
    })), r => r.qn) as Record<string, CodeLocation[]>;
    const { states, anchors, targets, tasks } = workspaceImplementation(root, snapshot.graph);
    return { ...snapshot, code, implementation: states, anchors, targets, tasks };
}

/** The implementation marks of the model files, by absolute path, for Appling Desktop's code view. */
export function fileMarks(snapshot: Snapshot): Record<string, LineMark[]> {
    const texts = Object.fromEntries(snapshot.files.map(f => [f.uri, f.text]));
    return Object.fromEntries(Object.entries(lineMarks(snapshot.locations, texts, { ...snapshot.implementation, ...snapshot.anchors })).map(([uri, marks]) => [URI.parse(uri).fsPath, marks]));
}

/** The code references of a snapshot by absolute file, with where each starts and ends now, for the code view's links back to the model. */
export function codeLinks(root: string, snapshot: Snapshot): Record<string, { qn: string, start: number, end: number }[]> {
    const links: Record<string, { qn: string, start: number, end: number }[]> = {};
    for (const [qn, locations] of Object.entries(snapshot.code)) {
        for (const l of locations) if (l.status !== 'broken' && l.status !== 'orphaned') (links[resolve(root, l.file)] ??= []).push({ qn, start: l.start, end: l.end });
    }
    return links;
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

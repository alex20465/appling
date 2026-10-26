import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { AstUtils, URI } from 'langium';
import { buildSources, errorsOf, type Model } from '@appling/lang';
import { buildGraph, dependencies, findApplingFiles, qualifiedNames, resolveReferences } from '@appling/model';
import type { CodeLocation, Location, Snapshot, ViewSettings } from '../shared/snapshot.js';

export async function snapshot(root: string): Promise<Snapshot> {
    const files = findApplingFiles(root).map(path => ({ uri: URI.file(path).toString(), path: relative(root, path), text: readFileSync(path, 'utf8') }));
    const workspace = await buildSources(Object.fromEntries(files.map(f => [f.uri, f.text])));
    const models = workspace.documents.map(d => d.parseResult.value as Model);
    const graph = buildGraph(models, workspace.services);
    const locations: Record<string, Location> = {};
    for (const [node, qn] of qualifiedNames(models)) {
        locations[qn] = { uri: AstUtils.getDocument(node).uri.toString(), start: node.$cstNode!.offset, end: node.$cstNode!.end };
    }
    const code = Object.groupBy(resolveReferences(root, graph).map(r => ({
        ...r, text: r.status === 'broken' ? '' : readFileSync(resolve(root, r.file), 'utf8').split('\n').slice(r.start - 1, r.end).join('\n')
    })), r => r.qn) as Record<string, CodeLocation[]>;
    return { root: URI.file(root).toString(), files, graph, dependencies: dependencies(graph), locations, code, errors: errorsOf(workspace) };
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

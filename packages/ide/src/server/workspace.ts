import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { AstUtils, URI } from 'langium';
import { buildSources, errorsOf, type Model } from '@appling/lang';
import { buildGraph, dependencies, findApplingFiles, qualifiedNames } from '@appling/model';
import type { Layout, Location, Snapshot } from '../shared/snapshot.js';

export async function snapshot(root: string): Promise<Snapshot> {
    const files = findApplingFiles(root).map(path => ({ uri: URI.file(path).toString(), path: relative(root, path), text: readFileSync(path, 'utf8') }));
    const workspace = await buildSources(Object.fromEntries(files.map(f => [f.uri, f.text])));
    const models = workspace.documents.map(d => d.parseResult.value as Model);
    const graph = buildGraph(models, workspace.services);
    const locations: Record<string, Location> = {};
    for (const [node, qn] of qualifiedNames(models)) {
        locations[qn] = { uri: AstUtils.getDocument(node).uri.toString(), start: node.$cstNode!.offset, end: node.$cstNode!.end };
    }
    return { root: URI.file(root).toString(), files, graph, dependencies: dependencies(graph), locations, errors: errorsOf(workspace) };
}

const LAYOUT = join('.appling', 'layout.json');

/** Positions and view state, kept outside the model so they never appear in model diffs. */
export function readLayout(root: string): Layout {
    const file = join(root, LAYOUT);
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
}

export function writeLayout(root: string, layout: Layout): void {
    const file = join(root, LAYOUT);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(layout, null, 2) + '\n');
}

import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { migrationRenames } from './diff.js';
import type { Graph } from './graph.js';
import { fingerprint } from './implementation.js';
import { removeMarkerLines, scanMarkers, writeMarker } from './markers.js';

/** Where an element is implemented: the declaration an `@appling` marker in the code belongs to. */
export interface CodeReference {
    /** Relative to the workspace folder. */
    file: string;
    /** The declaration, from 1. */
    start: number;
    end: number;
    /** The marker's own line. */
    line: number;
    /** The element's fingerprint the code was written against. */
    fingerprint?: string;
}

/**
 * `current`: the marker's fingerprint is the element's (or it has none). `stale`: the element changed since, or a
 * migration step renamed it. `orphaned`: the model has no element of that name.
 */
export type ReferenceStatus = 'current' | 'stale' | 'orphaned';

export interface ResolvedReference extends CodeReference {
    qn: string;
    status: ReferenceStatus;
    /** The name in the marker, when a migration step renamed the element since. */
    marked?: string;
}

/** The folders searched for markers: the git work tree around the workspace (or the workspace) and the given ones. */
export function markerFolders(root: string, extra: string[] = []): string[] {
    let top: string | undefined;
    for (let folder = resolve(root); ; folder = dirname(folder)) {
        if (existsSync(join(folder, '.git'))) top = folder;
        if (top || dirname(folder) === folder) break;
    }
    return [top ?? resolve(root), ...extra.map(f => resolve(root, f))];
}

/** The fingerprints markers carry: an element's own, a sub-anchor its element's. */
function markerFingerprints(graph: Graph): Map<string, string> {
    const prints = new Map(graph.nodes.map(n => [n.qn, fingerprint(n)]));
    for (const anchor of graph.anchors ?? []) {
        const owner = prints.get(anchor.owner);
        if (owner) prints.set(anchor.address, owner);
    }
    return prints;
}

/** The fingerprint a marker of an element or sub-anchor carries. */
export function markerFingerprint(graph: Graph, qn: string): string | undefined {
    return markerFingerprints(graph).get(qn);
}

/**
 * Every marker in the code of the workspace's folders (`markerFolders`) as a reference. With a graph, each gets its
 * status; a name the model lacks is mapped through the migration steps first.
 */
export async function resolveReferences(root: string, graph?: Graph, folders = markerFolders(root)): Promise<ResolvedReference[]> {
    const markers = await scanMarkers(folders);
    const prints = graph && markerFingerprints(graph);
    const renamed = graph && migrationRenames({ nodes: [], edges: [] }, graph);
    return markers.map(({ path, marker }) => {
        const reference = { file: relative(resolve(root), path), start: marker.start, end: marker.end, line: marker.line, ...(marker.fingerprint && { fingerprint: marker.fingerprint }) };
        if (!prints || !renamed) return { qn: marker.qn, ...reference, status: 'current' as const };
        const print = prints.get(marker.qn);
        if (print) return { qn: marker.qn, ...reference, status: !marker.fingerprint || marker.fingerprint === print ? 'current' as const : 'stale' as const };
        // a sub-anchor's element may be renamed too
        const [element, anchor] = marker.qn.split(/(?=#)/);
        const now = renamed(element);
        const qn = now && `${now}${anchor ?? ''}`;
        if (qn && prints.has(qn)) return { qn, ...reference, status: 'stale' as const, marked: marker.qn };
        return { qn: marker.qn, ...reference, status: 'orphaned' as const };
    });
}

/**
 * Marks where an element (or a sub-anchor) is implemented: a marker with its fingerprint above the declaration that
 * starts on each given line, renewing a marker it has there and removing its markers elsewhere. Paths may be absolute
 * or relative to the workspace folder and must lie in the folders searched for markers. An empty list removes every
 * marker of the element. Returns its references afterwards.
 */
export async function recordReferences(root: string, graph: Graph, qn: string, places: { file: string, line: number }[], folders = markerFolders(root)): Promise<CodeReference[]> {
    const print = markerFingerprint(graph, qn);
    if (!print) throw new Error(`No element or sub-anchor ${qn}.`);
    const operations = new Map<string, { line: number, run: () => Promise<unknown> | void }[]>();
    const add = (path: string, line: number, run: () => Promise<unknown> | void) => operations.set(path, [...operations.get(path) ?? [], { line, run }]);
    const targets = places.map(({ file, line }) => {
        const path = resolve(root, file);
        if (!existsSync(path)) throw new Error(`No file ${file}.`);
        if (!folders.some(folder => { const rel = relative(folder, path); return !rel.startsWith('..') && !isAbsolute(rel); })) {
            throw new Error(`${file} is outside the folders searched for markers: the git work tree of the workspace and the generated targets.`);
        }
        return { path, line };
    });
    const existing = (await resolveReferences(root, graph, folders)).filter(r => r.qn === qn);
    for (const reference of existing) {
        const path = resolve(root, reference.file);
        const kept = !reference.marked && targets.some(t => t.path === path && t.line === reference.start);
        if (!kept) add(path, reference.line, () => removeMarkerLines(path, [reference.line]));
    }
    for (const { path, line } of targets) add(path, line, () => writeMarker(path, line, qn, print));
    // from the bottom of each file up, so every line still means what it meant
    for (const list of operations.values()) for (const { run } of list.sort((a, b) => b.line - a.line)) await run();
    return (await resolveReferences(root, graph, folders)).filter(r => r.qn === qn).map(({ file, start, end, line, fingerprint }) => ({ file, start, end, line, ...(fingerprint && { fingerprint }) }));
}

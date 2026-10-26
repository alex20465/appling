import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { Graph } from './graph.js';

/** Where an element is implemented: a line range of a code file, and its first line as the anchor that finds it again. */
export interface CodeReference {
    /** Relative to the workspace folder. */
    file: string;
    start: number;
    end: number;
    anchor: string;
}

/** The code references of a workspace, by qualified name. */
export type References = Record<string, CodeReference[]>;

/**
 * `current`: the anchor is at the recorded start. `shifted`: the anchor moved, `start` and `end` are where it is now.
 * `broken`: the file or the anchor is gone. `orphaned`: the model has no element of that name anymore.
 */
export type ReferenceStatus = 'current' | 'shifted' | 'broken' | 'orphaned';

export interface ResolvedReference extends CodeReference {
    qn: string;
    status: ReferenceStatus;
    /** The recorded range, when it differs from `start` and `end`. */
    recorded?: { start: number, end: number };
}

export const REFERENCES = join('.appling', 'references.json');

export function readReferences(root: string): References {
    const file = join(root, REFERENCES);
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as References : {};
}

/**
 * Replaces the references of one element with the given line ranges and returns them. Paths may be absolute
 * or relative to the workspace folder. Throws for a missing file or a range outside it.
 */
export function recordReferences(root: string, qn: string, ranges: { file: string, start: number, end: number }[]): CodeReference[] {
    const references = ranges.map(({ file, start, end }) => {
        const path = resolve(root, file);
        if (!existsSync(path)) throw new Error(`No file ${file}.`);
        const lines = readFileSync(path, 'utf8').split('\n');
        if (!(start >= 1 && start <= end && end <= lines.length)) throw new Error(`Lines ${start}-${end} are outside ${file}, which has ${lines.length} lines.`);
        const anchor = lines[start - 1].trim();
        if (!anchor) throw new Error(`Line ${start} of ${file} is empty; start the range at the first line of the code.`);
        return { file: relative(resolve(root), path), start, end, anchor };
    });
    const all = readReferences(root);
    if (references.length) all[qn] = references;
    else delete all[qn];
    mkdirSync(dirname(join(root, REFERENCES)), { recursive: true });
    writeFileSync(join(root, REFERENCES), JSON.stringify(all, null, 2) + '\n');
    return references;
}

/** Every reference with where it is now, nearest occurrence of its anchor first. With a graph, references to elements it lacks are orphaned. */
export function resolveReferences(root: string, graph?: Graph): ResolvedReference[] {
    const names = graph && new Set(graph.nodes.map(n => n.qn));
    return Object.entries(readReferences(root)).flatMap(([qn, references]) => references.map(reference => {
        if (names && !names.has(qn)) return { qn, ...reference, status: 'orphaned' as const };
        const path = resolve(root, reference.file);
        const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : [];
        if (lines[reference.start - 1]?.trim() === reference.anchor) return { qn, ...reference, status: 'current' as const };
        const found = lines.flatMap((line, i) => (line.trim() === reference.anchor ? [i + 1] : []))
            .sort((a, b) => Math.abs(a - reference.start) - Math.abs(b - reference.start))[0];
        if (!found) return { qn, ...reference, status: 'broken' as const };
        const recorded = { start: reference.start, end: reference.end };
        return { qn, ...reference, start: found, end: found + reference.end - reference.start, status: 'shifted' as const, recorded };
    }));
}

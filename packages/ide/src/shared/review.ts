import type { GraphDiff } from '@appling/model/diff';
import type { Graph } from '@appling/model/graph';
import type { Location, SourceFile } from './snapshot.js';

/** A file that differs between a revision and the working tree, by its path in the workspace folder. */
export interface ChangedFile {
    path: string;
    /** `added`, `modified`, `deleted`, `renamed` (from `from`) or `untracked`. */
    status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
    from?: string;
}

export interface Revision {
    hash: string;
    short: string;
    subject: string;
    author: string;
    /** When it was committed, relative, such as "2 hours ago". */
    date: string;
}

/** The model at a revision compared with the working tree, with the files that changed. */
export type Review = {
    ok: true;
    /** The revision as asked for, such as `HEAD`, and the commit it names. */
    rev: string;
    commit: string;
    files: ChangedFile[];
    diff: GraphDiff;
    /** The model at the revision: its graph, its `.appling` files and where every element is in them. */
    before: { graph: Graph, files: SourceFile[], locations: Record<string, Location> };
} | { ok: false, error: string };

/** One file at a revision and in the working tree; null where it does not exist. */
export interface FileDiff {
    path: string;
    before: string | null;
    after: string | null;
}

/** Where the text diff of a changed element or file should open. The Code OSS view of Appling Desktop implements it. */
export interface TextDiffRequest {
    /** The file in the workspace folder, now (or before, for a deleted one). */
    path: string;
    /** The file's path at the revision, when it differs. */
    before?: string;
    rev: string;
    /** The line to reveal, counted from 1. */
    line?: number;
    qn?: string;
}

export interface DiffLine {
    op: ' ' | '+' | '-';
    text: string;
}

/** A line diff by longest common subsequence after the common start and end, enough for elements and model files. */
export function lineDiff(before: string, after: string): DiffLine[] {
    const [a, b] = [before ? before.split('\n') : [], after ? after.split('\n') : []];
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let end = 0;
    while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
    const [x, y] = [a.slice(start, a.length - end), b.slice(start, b.length - end)];
    const width = y.length + 1;
    const lcs = new Uint32Array((x.length + 1) * width);
    for (let i = x.length - 1; i >= 0; i--) {
        for (let j = y.length - 1; j >= 0; j--) {
            lcs[i * width + j] = x[i] === y[j] ? lcs[(i + 1) * width + j + 1] + 1 : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
        }
    }
    const middle: DiffLine[] = [];
    let [i, j] = [0, 0];
    while (i < x.length || j < y.length) {
        if (i < x.length && j < y.length && x[i] === y[j]) {
            middle.push({ op: ' ', text: x[i++] });
            j++;
        } else if (j < y.length && (i === x.length || lcs[i * width + j + 1] >= lcs[(i + 1) * width + j])) middle.push({ op: '+', text: y[j++] });
        else middle.push({ op: '-', text: x[i++] });
    }
    const same = (text: string): DiffLine => ({ op: ' ', text });
    return [...a.slice(0, start).map(same), ...middle, ...a.slice(a.length - end).map(same)];
}

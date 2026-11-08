import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The code one step wrote for a node: the lines a template added to a file, or a file a command created. */
export interface Written {
    node: string;
    /** Relative to the output folder. */
    file: string;
    /** The added lines; undefined for a whole file a command created. */
    lines?: string[];
}

/** A line range of a generated file, relative to the output folder. */
export interface WrittenRange {
    file: string;
    start: number;
    end: number;
}

/**
 * The runs of lines `after` adds to `before`, by a longest common subsequence of lines. Files the generators write are
 * small enough for the quadratic table; past `limit` lines on both sides it falls back to the common prefix and suffix.
 */
export function addedRuns(before: string | undefined, after: string, limit = 4000): string[][] {
    const [a, b] = [before === undefined ? [] : before.split('\n'), after.split('\n')];
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    const [x, y] = [a.slice(head, a.length - tail), b.slice(head, b.length - tail)];
    if (!y.length) return [];
    if (!x.length || x.length * y.length > limit * limit) return [y];
    const table = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
    for (let i = x.length - 1; i >= 0; i--) {
        for (let j = y.length - 1; j >= 0; j--) table[i][j] = x[i] === y[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
    const runs: string[][] = [];
    let run: string[] = [];
    let [i, j] = [0, 0];
    while (j < y.length) {
        if (i < x.length && x[i] === y[j]) {
            if (run.length) runs.push(run);
            run = [];
            i++;
            j++;
        } else if (i < x.length && table[i + 1][j] >= table[i][j + 1]) i++;
        else run.push(y[j++]);
    }
    if (run.length) runs.push(run);
    return runs;
}

/** Lines that import rather than declare, which later steps rewrite: Python, JavaScript, Go and Elixir style. */
const IMPORT = /^\s*(from\s+\S+\s+import\s|import\s|alias\s|require\s|package\s)/;

/**
 * The largest of the runs by lines that are not blank: the code a template step added. Leading blank and import lines
 * are left out, so the range starts at the code it declares.
 */
export function mainRun(runs: string[][]): string[] | undefined {
    const weight = (run: string[]) => run.filter(l => l.trim()).length;
    const trimmed = runs.map(run => {
        let [start, end] = [0, run.length];
        while (start < end && (!run[start].trim() || IMPORT.test(run[start]))) start++;
        while (end > start && !run[end - 1].trim()) end--;
        return run.slice(start, end);
    }).filter(run => run.length);
    return trimmed.sort((p, q) => weight(q) - weight(p))[0];
}

/**
 * Where the written code is in the output folder now that every step ran: each run of added lines is looked up in its
 * file's final text (later steps may have moved it, such as imports added above), a created file covers its lines.
 * Runs that a later step changed are not found and left out. The result is by node, deduplicated.
 */
export function locateWritten(out: string, written: Written[], only?: Set<string>): Record<string, WrittenRange[]> {
    const root = resolve(out);
    const texts = new Map<string, string[] | undefined>();
    const linesOf = (file: string) => {
        if (!texts.has(file)) {
            const path = join(root, file);
            texts.set(file, existsSync(path) && statSync(path).isFile() ? readFileSync(path, 'utf8').split('\n') : undefined);
        }
        return texts.get(file);
    };
    const result: Record<string, WrittenRange[]> = {};
    for (const { node, file, lines } of written) {
        if (only && !only.has(node)) continue;
        const text = linesOf(file);
        if (!text) continue;
        let range: WrittenRange | undefined;
        if (!lines) {
            const end = text.length - (text[text.length - 1] === '' ? 1 : 0);
            const start = text.findIndex(l => l.trim()) + 1;
            if (start > 0) range = { file, start, end };
        } else {
            const found = locate(text, lines);
            if (found) range = { file, start: found.start + 1, end: found.start + found.length };
        }
        if (!range) continue;
        const ranges = result[node] ??= [];
        if (!ranges.some(r => r.file === range.file && r.start === range.start && r.end === range.end)) ranges.push(range);
    }
    return result;
}

/**
 * The lines in the text, or their longest end, then their longest start, that is still there: a step that created a
 * file wrote its header too, which later steps rewrite (such as imports). A part starts on a line that is not blank
 * and has two lines at least, unless the run has one.
 */
function locate(text: string[], lines: string[]): { start: number, length: number } | undefined {
    const least = Math.min(2, lines.length);
    for (let from = 0; lines.length - from >= least; from++) {
        if (!lines[from].trim()) continue;
        const start = find(text, lines.slice(from));
        if (start >= 0) return { start, length: lines.length - from };
    }
    for (let to = lines.length - 1; to >= least; to--) {
        const start = find(text, lines.slice(0, to));
        if (start >= 0) return { start, length: to };
    }
    return undefined;
}

function find(text: string[], lines: string[]): number {
    outer: for (let i = 0; i + lines.length <= text.length; i++) {
        for (let j = 0; j < lines.length; j++) if (text[i + j] !== lines[j]) continue outer;
        return i;
    }
    return -1;
}

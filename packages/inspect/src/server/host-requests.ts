import * as nativePath from 'node:path';
import type { TextDiffRequest } from '../shared/review.js';

export type { TextDiffRequest };

/**
 * The requests the inspector client makes of the app around it to open something in its editor, checked before the app
 * acts on them (the VS Code extension): every path must stay inside the repo.
 */

/**
 * Open the diff editor of a file between a git revision and the working tree: `before` is the file's absolute path at
 * `rev` (it differs after a rename), `path` its absolute path now; `line` (from 1) is revealed.
 */
export interface DiffMessage {
    type: 'diff';
    path: string;
    before: string;
    rev: string;
    line?: number;
}

/** Open a code file at a line range (from 1). */
export interface OpenMessage {
    type: 'open';
    path: string;
    start: number;
    end: number;
}

/** The path functions of the machine a repo's files are on: this one's, or POSIX ones for a remote repo. */
export type PathFunctions = Pick<typeof nativePath, 'dirname' | 'isAbsolute' | 'relative' | 'resolve'>;

/**
 * The diff request checked; undefined unless both paths stay inside the repo and the revision is plain.
 * `repo` is the repo's folder where its code view runs: for a remote repo its folder on that machine, with
 * `path.posix` as `path`, so the extension there gets that machine's absolute paths.
 */
export function diffMessage(repo: string, request: TextDiffRequest, path: PathFunctions = nativePath): DiffMessage | undefined {
    const { isAbsolute, relative, resolve } = path;
    if (!request || typeof request.path !== 'string' || typeof request.rev !== 'string') return undefined;
    // a revision, never an option for git
    if (!/^[\w./~^@{}:-]+$/.test(request.rev) || request.rev.startsWith('-')) return undefined;
    const inside = (file: string) => {
        const absolute = resolve(repo, file);
        const rel = relative(repo, absolute);
        return rel && !rel.startsWith('..') && !isAbsolute(rel) ? absolute : undefined;
    };
    const now = inside(request.path);
    const before = inside(typeof request.before === 'string' ? request.before : request.path);
    if (!now || !before) return undefined;
    const line = Number.isInteger(request.line) && request.line! > 0 ? request.line : undefined;
    return { type: 'diff', path: now, before, rev: request.rev, ...(line ? { line } : {}) };
}

/**
 * The open request checked; undefined unless the file stays inside the repo and the lines are plain.
 * The inspector names the file relative to the repo, or by the absolute path its server sees; `repo` and `path` as for
 * `diffMessage`.
 */
export function openMessage(repo: string, request: { path: string, start: number, end?: number }, path: PathFunctions = nativePath): OpenMessage | undefined {
    if (!request || typeof request.path !== 'string' || !Number.isInteger(request.start) || request.start < 1) return undefined;
    const { dirname, isAbsolute, relative, resolve } = path;
    const file = resolve(repo, request.path);
    const rel = relative(repo, file);
    // generated projects may live next to the repo (`"out": "../app"`), so only the parent of the repo is allowed besides it
    const parent = relative(dirname(repo), file);
    if (!rel || isAbsolute(rel) || parent.startsWith('..') || isAbsolute(parent)) return undefined;
    const end = Number.isInteger(request.end) && request.end! >= request.start ? request.end! : request.start;
    return { type: 'open', path: file, start: request.start, end };
}

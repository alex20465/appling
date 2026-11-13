import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { URI } from 'langium';
import { diffGraphs } from '@appling/model';
import { buildSnapshot } from '../shared/model.js';
import type { ChangedFile, Review, Revision } from '../shared/review.js';
import type { Snapshot } from '../shared/snapshot.js';

/** Runs git in a folder and returns its output; rejects with git's message. */
export function git(cwd: string, args: string[]): Promise<string> {
    return new Promise((done, fail) => execFile('git', ['--no-optional-locks', ...args], { cwd, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
        if (error) fail(new Error((stderr || error.message).trim()));
        else done(stdout);
    }));
}

/** Revisions such as `HEAD`, `HEAD~2`, `main`, `v1.0` or a commit; nothing git could read as an option. */
const REVISION = /^[\w][\w./~^@{}+-]*$/;

/** The commit a revision names, verified by git. */
export async function commitOf(root: string, rev: string): Promise<string> {
    if (!REVISION.test(rev)) throw new Error(`Not a revision: ${rev}`);
    return (await git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`])).trim();
}

/** The `.appling` files of the folder at a commit, by their path in the folder, skipping hidden folders and `node_modules` as the working tree does. */
export async function filesAt(root: string, commit: string): Promise<{ path: string, text: string }[]> {
    const listed = (await git(root, ['ls-tree', '-r', '-z', '--name-only', commit, '--', '.'])).split('\0').filter(Boolean);
    const paths = listed.filter(path => path.endsWith('.appling') && !path.split('/').slice(0, -1).some(part => part.startsWith('.') || part === 'node_modules'));
    return Promise.all(paths.map(async path => ({ path, text: await git(root, ['show', `${commit}:./${path}`]) })));
}

/**
 * The files that differ between a commit and the working tree, inside the folder: `git diff --name-status` against
 * the commit (staged and unstaged changes alike) plus the untracked files of `git status --porcelain`.
 */
export async function changedFiles(root: string, commit: string): Promise<ChangedFile[]> {
    const files = new Map<string, ChangedFile>();
    const diff = (await git(root, ['diff', '--name-status', '-z', '--relative', '-M', commit, '--', '.'])).split('\0');
    for (let i = 0; i < diff.length - 1;) {
        const code = diff[i++];
        if (code.startsWith('R') || code.startsWith('C')) {
            const [from, path] = [diff[i++], diff[i++]];
            files.set(path, { path, status: code.startsWith('R') ? 'renamed' : 'added', from });
        } else {
            const path = diff[i++];
            files.set(path, { path, status: code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified' });
        }
    }
    const prefix = (await git(root, ['rev-parse', '--show-prefix'])).trim();
    const status = (await git(root, ['status', '--porcelain', '-z', '--untracked-files=all', '--', '.'])).split('\0');
    for (let i = 0; i < status.length; i++) {
        const entry = status[i];
        if (entry.startsWith('R') || entry.startsWith('C')) i++;
        if (!entry.startsWith('?? ')) continue;
        // porcelain paths are relative to the repo root
        const path = entry.slice(3);
        if (path.startsWith(prefix)) files.set(path.slice(prefix.length), { path: path.slice(prefix.length), status: 'untracked' });
    }
    return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** The model at a revision compared with the working tree (`now`, the current snapshot), with the changed files. */
export async function review(root: string, rev: string, now: Snapshot): Promise<Review> {
    let commit: string;
    try {
        commit = await commitOf(root, rev);
    } catch (error) {
        const message = (error as Error).message;
        return { ok: false, error: /not a git repository/i.test(message) ? 'This folder is not in a git repository.' : message || `Unknown revision: ${rev}` };
    }
    if (!commit) return { ok: false, error: `Unknown revision: ${rev}` };
    const [texts, files] = await Promise.all([filesAt(root, commit), changedFiles(root, commit)]);
    const before = await buildSnapshot(now.root, texts.map(f => ({ uri: URI.file(join(root, f.path)).toString(), path: f.path, text: f.text })));
    return {
        ok: true, rev, commit, files,
        diff: diffGraphs(before.graph, now.graph),
        before: { graph: before.graph, files: before.files, locations: before.locations }
    };
}

/** The latest commits that touch the folder, newest first. */
export async function revisions(root: string, count = 50): Promise<Revision[]> {
    const output = await git(root, ['log', `-n${count}`, '-z', '--format=%H%x1f%h%x1f%s%x1f%an%x1f%cr', '--', '.']).catch(() => '');
    return output.split('\0').filter(Boolean).map(line => {
        const [hash, short, subject, author, date] = line.replace(/^\n/, '').split('\x1f');
        return { hash, short, subject, author, date };
    });
}

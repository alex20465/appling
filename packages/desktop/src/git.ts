import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * The `HEAD` file of a repo's git folder: `.git/HEAD`, or for a worktree or submodule (where `.git` is a file
 * with `gitdir: <path>`) the one in the folder it names. Undefined when the folder is not the root of a git repo.
 */
export function headFile(repo: string): string | undefined {
    const dotGit = join(repo, '.git');
    if (!existsSync(dotGit)) return undefined;
    if (statSync(dotGit).isDirectory()) return join(dotGit, 'HEAD');
    const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'))?.[1];
    if (!gitdir) return undefined;
    const head = join(isAbsolute(gitdir) ? gitdir : resolve(repo, gitdir), 'HEAD');
    return existsSync(head) ? head : undefined;
}

/**
 * The branch checked out in a repo, read from its `HEAD` file without running git: the branch name, the first
 * seven characters of the commit while the head is detached, undefined outside git.
 */
export function gitBranch(repo: string): string | undefined {
    const file = headFile(repo);
    if (!file) return undefined;
    const head = readFileSync(file, 'utf8').trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)?.[1];
    if (ref) return ref;
    return /^[0-9a-f]{40,64}$/.test(head) ? head.slice(0, 7) : undefined;
}

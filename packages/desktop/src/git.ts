import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

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

/** What the rail shows of a repo's git state. */
export interface GitState {
    /** The checked out branch (a short commit while detached); undefined outside git. */
    branch?: string;
    /** The branch it tracks, such as `origin/main`. */
    upstream?: string;
    /** Commits on the branch that its upstream lacks, and the other way round. */
    ahead: number;
    behind: number;
    /** Files with uncommitted changes, untracked ones included. */
    dirty: number;
}

/** Reads `git status --porcelain=v2 --branch -z`. */
export function parseGitStatus(output: string): GitState {
    const state: GitState = { ahead: 0, behind: 0, dirty: 0 };
    let oid: string | undefined;
    const fields = output.split('\0');
    for (let i = 0; i < fields.length; i++) {
        const field = fields[i];
        if (!field) continue;
        if (field.startsWith('# ')) {
            const [, key, ...rest] = field.split(' ');
            const value = rest.join(' ');
            if (key === 'branch.oid') oid = value;
            else if (key === 'branch.head' && value !== '(detached)') state.branch = value;
            else if (key === 'branch.upstream') state.upstream = value;
            else if (key === 'branch.ab') [state.ahead, state.behind] = rest.map(n => Math.abs(Number(n)));
            continue;
        }
        // a rename or copy carries the original path in the next field
        if (field.startsWith('2 ')) i++;
        if (/^[12u?] /.test(field)) state.dirty++;
    }
    if (!state.branch && oid && /^[0-9a-f]{7,}$/.test(oid)) state.branch = oid.slice(0, 7);
    return state;
}

/** The git state of a repo from the git CLI; without git (or outside a repo) just the branch from `HEAD`. */
export function readGitState(repo: string): Promise<GitState> {
    const args = ['--no-optional-locks', 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal'];
    return new Promise(done => execFile('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
        done(error ? { branch: gitBranch(repo), ahead: 0, behind: 0, dirty: 0 } : parseGitStatus(stdout));
    }));
}

/**
 * Follows a repo's git state: reads it now, whenever its git folder changes (a commit, a checkout, staging, a fetch)
 * and every `interval` milliseconds for edits in the working tree. Calls back only when the state differs.
 * Returns the function that stops it.
 */
export function watchGit(repo: string, onChange: (state: GitState) => void, interval = 5000): () => void {
    let last = '';
    let stopped = false;
    let reading = false;
    let again = false;
    const read = (): void => {
        if (reading) {
            again = true;
            return;
        }
        reading = true;
        readGitState(repo).then(state => {
            const key = JSON.stringify(state);
            if (!stopped && key !== last) {
                last = key;
                onChange(state);
            }
            reading = false;
            if (again && !stopped) {
                again = false;
                read();
            }
        });
    };
    read();
    const head = headFile(repo);
    let watcher: FSWatcher | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
        watcher = head ? watch(dirname(head), () => {
            clearTimeout(timer);
            timer = setTimeout(read, 100);
        }) : undefined;
    } catch {
        // the poll still catches every change
    }
    const poll = setInterval(read, interval);
    return () => {
        stopped = true;
        watcher?.close();
        clearTimeout(timer);
        clearInterval(poll);
    };
}

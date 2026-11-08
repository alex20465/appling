import { spawn } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The folder name `git clone` would pick for a URL: the last path segment without `.git`, for https, ssh
 * (`git@host:owner/repo.git`), `file://` URLs and local paths. Undefined when there is none.
 */
export function cloneFolderName(url: string): string | undefined {
    const trimmed = url.trim().replace(/[\\/]+$/, '').replace(/\.git$/, '').replace(/[\\/]+$/, '');
    const name = trimmed.split(/[\\/:]/).pop();
    return name && name !== '.' && name !== '..' && !/^\s*$/.test(name) ? name : undefined;
}

export interface CloneProgress {
    /** Such as `Receiving objects` or `Resolving deltas`. */
    phase: string;
    /** 0..100 within the phase, when git reports one. */
    percent?: number;
}

/** Reads one progress line of `git clone --progress` (git separates them with carriage returns). */
export function parseCloneProgress(line: string): CloneProgress | undefined {
    const match = /^(?:remote:\s*)?([A-Z][A-Za-z ]+?):\s+(\d{1,3})%/.exec(line.trim());
    if (match) return { phase: match[1], percent: Number(match[2]) };
    const start = /^Cloning into '?(.+?)'?\.\.\.$/.exec(line.trim());
    return start ? { phase: 'Cloning' } : undefined;
}

export interface CloneOptions {
    onProgress?(progress: CloneProgress): void;
    signal?: AbortSignal;
    /** The git binary; default `git` on the PATH. */
    git?: string;
}

/**
 * Clones a repo into a new folder below `parent` (named after the URL unless `name` is given) with `git clone
 * --progress`, reporting each progress line. Resolves with the new folder; rejects with git's own message when it
 * fails, after removing what it left behind. Git never asks for credentials on a terminal here: it fails instead.
 */
export function cloneRepo(url: string, parent: string, options: CloneOptions & { name?: string } = {}): Promise<string> {
    const name = options.name ?? cloneFolderName(url);
    if (!url.trim()) return Promise.reject(new Error('Enter the URL of a git repository.'));
    if (!name) return Promise.reject(new Error(`No folder name follows from ${url}; give one.`));
    const target = resolve(parent, name);
    if (existsSync(target) && readdirSync(target).length) return Promise.reject(new Error(`${target} exists already and is not empty.`));
    if (!existsSync(resolve(parent))) return Promise.reject(new Error(`${resolve(parent)} does not exist.`));
    return new Promise((done, fail) => {
        const child = spawn(options.git ?? 'git', ['clone', '--progress', '--', url.trim(), target], {
            stdio: ['ignore', 'ignore', 'pipe'],
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes' },
            signal: options.signal
        });
        let output = '';
        let rest = '';
        child.stderr!.setEncoding('utf8');
        child.stderr!.on('data', (chunk: string) => {
            output = (output + chunk).slice(-8000);
            const lines = (rest + chunk).split(/[\r\n]/);
            rest = lines.pop()!;
            for (const line of lines) {
                const progress = parseCloneProgress(line);
                if (progress) options.onProgress?.(progress);
            }
        });
        const cleanUp = () => {
            if (existsSync(target)) rmSync(target, { recursive: true, force: true });
        };
        child.once('error', error => {
            cleanUp();
            fail((error as NodeJS.ErrnoException).code === 'ENOENT' ? new Error('git was not found on the PATH.') : error.name === 'AbortError' ? new Error('The clone was cancelled.') : error);
        });
        child.once('close', code => {
            if (code === 0) return done(target);
            if (code === null) return;
            cleanUp();
            fail(new Error(gitMessage(output) || `git clone ended with code ${code}.`));
        });
    });
}

/** The lines of git's output that say what went wrong (`fatal:`, `error:`, `remote:` lines without progress). */
function gitMessage(output: string): string {
    const lines = output.split(/[\r\n]+/).map(l => l.trim()).filter(l => l && !parseCloneProgress(l));
    const important = lines.filter(l => /^(fatal|error|remote):/.test(l));
    return (important.length ? important : lines.slice(-3)).join('\n');
}

/** Where the clone dialog proposes to clone: next to the workspace's first repo, else the home folder's `src` or home. */
export function defaultCloneParent(workspaceFolders: readonly string[], home: string): string {
    const first = workspaceFolders[0];
    if (first) return resolve(first, '..');
    const src = join(home, 'src');
    return existsSync(src) ? src : home;
}

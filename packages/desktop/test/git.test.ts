import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { parseGitStatus, readGitState, watchGit, type GitState } from '../src/git.js';

test('porcelain v2 status gives branch, upstream, ahead, behind and the changed files', () => {
    const output = [
        '# branch.oid 1234567890abcdef1234567890abcdef12345678', '# branch.head feature/rail', '# branch.upstream origin/feature/rail', '# branch.ab +2 -1',
        '1 .M N... 100644 100644 100644 aaa bbb shop.appling',
        '2 R. N... 100644 100644 100644 aaa bbb R100 new.appling', 'old.appling',
        'u UU N... 100644 100644 100644 100644 a b c conflict.txt',
        '? notes.txt', '! ignored.log', ''
    ].join('\0');
    expect(parseGitStatus(output)).toEqual({ branch: 'feature/rail', upstream: 'origin/feature/rail', ahead: 2, behind: 1, dirty: 4 });
    expect(parseGitStatus('# branch.oid 1234567890abcdef1234567890abcdef12345678\0# branch.head (detached)\0')).toEqual({ branch: '1234567', ahead: 0, behind: 0, dirty: 0 });
    expect(parseGitStatus('# branch.oid (initial)\0# branch.head main\0? a\0')).toEqual({ branch: 'main', ahead: 0, behind: 0, dirty: 1 });
});

test('the git state of a real repo, followed as it changes; outside git just no branch', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'appling-desktop-git-'));
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: repo });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    expect(await readGitState(repo)).toEqual({ branch: 'main', ahead: 0, behind: 0, dirty: 1 });
    git('add', '.');
    git('commit', '-q', '-m', 'first');
    expect(await readGitState(repo)).toEqual({ branch: 'main', ahead: 0, behind: 0, dirty: 0 });

    const states: GitState[] = [];
    let seen: () => void = () => { };
    const stop = watchGit(repo, state => {
        states.push(state);
        seen();
    }, 50);
    const next = () => new Promise<void>(done => seen = done);
    await next();
    writeFileSync(join(repo, 'a.txt'), 'b\n');
    await next();
    stop();
    expect(states.map(s => s.dirty)).toEqual([0, 1]);

    expect(await readGitState(mkdtempSync(join(tmpdir(), 'appling-desktop-nogit-')))).toEqual({ branch: undefined, ahead: 0, behind: 0, dirty: 0 });
});

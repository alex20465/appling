import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { startIde, type Ide } from '../src/server/server.js';
import { lineDiff, type Review } from '../src/shared/review.js';

const SHOP = `module shop {
  entity Order {
    total: Decimal
    note: String
  }

  entity Customer {
    name: String
  }
}
`;

let repo: string;
let root: string;
let ide: Ide;

const run = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' });

beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'appling-git-'));
    // the workspace folder is a subfolder of the repo, as in a monorepo
    root = join(repo, 'model');
    mkdirSync(root);
    run('init', '-q', '-b', 'main');
    writeFileSync(join(root, 'shop.appling'), SHOP);
    writeFileSync(join(root, 'old.txt'), 'old\n');
    writeFileSync(join(repo, 'outside.txt'), 'x\n');
    run('add', '.');
    run('commit', '-q', '-m', 'first');
    writeFileSync(join(root, 'shop.appling'), SHOP.replace('    note: String\n', '    note: String\n    paid: Bool\n').replace(/\n  entity Customer \{\n    name: String\n  \}\n/, ''));
    run('commit', '-q', '-am', 'second');
    writeFileSync(join(root, 'shop.appling'), SHOP.replace('total: Decimal', 'total: Integer'));
    writeFileSync(join(root, 'extra.appling'), 'module extra {\n  entity Tag {\n  }\n}\n');
    rmSync(join(root, 'old.txt'));
    writeFileSync(join(repo, 'outside.txt'), 'y\n');
    ide = await startIde(root);
});

afterAll(() => ide.close());

const get = async <T>(path: string): Promise<T> => (await fetch(`${ide.url}${path}`)).json() as Promise<T>;

test('the model at HEAD against the working tree, with the changed files of the folder', async () => {
    const review = await get<Review>('/api/diff?rev=HEAD');
    if (!review.ok) throw new Error(review.error);
    expect(review.commit).toBe(run('rev-parse', 'HEAD').trim());
    expect(review.diff.added).toEqual(['extra', 'extra.Tag', 'shop.Customer', 'shop.Customer.name']);
    expect(review.diff.removed).toEqual(['shop.Order.paid']);
    expect(review.diff.changed).toEqual(['shop.Order.total']);
    expect(review.files).toEqual([
        { path: 'extra.appling', status: 'untracked' },
        { path: 'old.txt', status: 'deleted' },
        { path: 'shop.appling', status: 'modified' }
    ]);
    expect(review.before.files.map(f => f.path)).toEqual(['shop.appling']);
    const location = review.before.locations['shop.Order.paid'];
    expect(review.before.files[0].text.slice(location.start, location.end)).toBe('paid: Bool');
});

test('any commit compares with the working tree', async () => {
    const review = await get<Review>('/api/diff?rev=HEAD~1');
    if (!review.ok) throw new Error(review.error);
    expect(review.diff.added).toEqual(['extra', 'extra.Tag']);
    expect(review.diff.changed).toEqual(['shop.Order.total']);
    expect(review.diff.removed).toEqual([]);
});

test('unknown and unsafe revisions are refused', async () => {
    expect(await get('/api/diff?rev=nope')).toMatchObject({ ok: false });
    expect(await get('/api/diff?rev=--output=x')).toEqual({ ok: false, error: 'Not a revision: --output=x' });
});

test('the revisions that touch the folder and a file at a revision', async () => {
    expect((await get<{ subject: string }[]>('/api/revisions')).map(r => r.subject)).toEqual(['second', 'first']);
    const file = await get<{ before: string, after: string }>('/api/diff/file?rev=HEAD~1&path=shop.appling');
    expect(file).toEqual({ path: 'shop.appling', before: SHOP, after: readFileSync(join(root, 'shop.appling'), 'utf8') });
    expect(await get('/api/diff/file?rev=HEAD&path=extra.appling')).toMatchObject({ before: null });
    expect(await get('/api/diff/file?rev=HEAD&path=../outside.txt')).toEqual({ error: 'Only files inside the workspace can be compared.' });
});

test('a line diff keeps the common lines and marks what was removed and added', () => {
    expect(lineDiff('a\nb\nc\nd', 'a\nc\nx\nd')).toEqual([
        { op: ' ', text: 'a' }, { op: '-', text: 'b' }, { op: ' ', text: 'c' }, { op: '+', text: 'x' }, { op: ' ', text: 'd' }
    ]);
    expect(lineDiff('', 'a')).toEqual([{ op: '+', text: 'a' }]);
    expect(lineDiff('a', '')).toEqual([{ op: '-', text: 'a' }]);
});

test('a folder outside git has no review', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'appling-nogit-'));
    const other = await startIde(plain);
    try {
        expect(await (await fetch(`${other.url}/api/diff`)).json()).toMatchObject({ ok: false });
        expect(await (await fetch(`${other.url}/api/revisions`)).json()).toEqual([]);
    } finally {
        await other.close();
    }
});

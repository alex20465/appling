import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import { openChapter, type Playbook } from '@appling/ai';
import { startIde, type Ide } from '../src/server/server.js';

const WORKSPACE = '/work/team.code-workspace';
let ide: Ide;
let root: string;

beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'appling-ide-playbook-'));
    cpSync(join(import.meta.dirname, '../../../examples'), root, { recursive: true });
    ide = await startIde(root, 0, { host: { context: async () => ({ workspace: WORKSPACE }) } });
});

afterAll(() => ide.close());

async function agent(token: string) {
    const client = new Client({ name: 'agent', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(ide.mcp), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return async (name: string, args: Record<string, unknown> = {}) => JSON.parse(((await client.callTool({ name, arguments: args })).content as { text: string }[])[0].text);
}

async function playbookEvents(workspace?: string) {
    const socket = new WebSocket(ide.url.replace('http', 'ws') + '/events' + (workspace ? `?workspace=${encodeURIComponent(workspace)}` : ''), { origin: ide.url });
    const books: Playbook[] = [];
    const waiters: (() => void)[] = [];
    socket.on('message', data => {
        const message = JSON.parse(data.toString());
        if (message.type === 'playbook') books.push(message.playbook);
        waiters.splice(0).forEach(w => w());
    });
    await new Promise(resolve => socket.on('open', resolve));
    const next = async (match: (book: Playbook) => boolean) => {
        for (;;) {
            const found = books.findLast(match);
            if (found) return found;
            await new Promise<void>(done => waiters.push(done));
        }
    };
    return { socket, next, books };
}

const post = (path: string, body: unknown) => fetch(`${ide.url}${path}`, { method: 'POST', body: JSON.stringify(body) });

test('a session\'s chapter reaches the client, the user steps and responds, and the response reaches the session', async () => {
    const events = await playbookEvents();
    await events.next(book => book.workspace === WORKSPACE && !book.chapters.length);
    const { session, token } = await ide.sessions.open({ name: 'Claude Code', repo: root, workspace: WORKSPACE });
    const call = await agent(token);
    const { chapter } = await call('playbook_open_chapter', { title: 'Invoices', plan: 'Add invoices', steps: [{ elements: ['sales.Order'], change: 'change', note: 'Add a discount' }] });
    const pushed = await events.next(book => book.chapters.length === 1);
    expect(pushed.chapters[0]).toMatchObject({ title: 'Invoices', session: session.id, color: session.color });

    // the app writes a chapter of its own, which queues after it
    const generation = await openChapter(ide.playbooks, { workspace: WORKSPACE, repo: '/work/shop', label: 'Generate Django', color: '#1971c2' }, { title: 'Generate', plan: 'Django' });
    await events.next(book => book.chapters.length === 2);

    const moved = await (await post('/api/playbook/position', { workspace: WORKSPACE, chapter: chapter.id, step: 1 })).json() as Playbook;
    expect(moved.position).toEqual({ chapter: chapter.id, step: 1 });
    expect((await call('playbook_read')).watching).toMatchObject({ chapter: chapter.id, step: 1, of: 1 });
    expect((await call('playbook_read')).queued).toMatchObject([{ chapter: generation.id, title: 'Generate' }]);

    expect(await (await post('/api/playbook/respond', { chapter: chapter.id, step: 1, kind: 'comment', text: 'Use a percentage' })).json()).toEqual({ ok: true, delivered: true });
    expect((await call('session_inbox')).messages).toMatchObject([{ fromLabel: 'User', text: expect.stringMatching(/commented on step 1.*Use a percentage/) }]);
    expect((await post('/api/playbook/respond', { chapter: chapter.id, step: 1, kind: 'shrug' })).status).toBe(400);
    expect((await post('/api/playbook/position', { workspace: WORKSPACE, chapter: 'nope', step: 0 })).status).toBe(400);

    const read = await (await fetch(`${ide.url}/api/playbook`)).json() as Playbook;
    expect(read.chapters[0].steps[0].responses).toMatchObject([{ kind: 'comment', text: 'Use a percentage' }]);
    events.socket.close();
});

test('a repo view in a window of another workspace plays that workspace\'s playbook, and follows it when it moves', async () => {
    const OTHER = '/work/other.code-workspace';
    const shown = await playbookEvents();
    const other = await playbookEvents(OTHER);
    await other.next(book => book.workspace === OTHER);
    expect(await (await fetch(`${ide.url}/api/playbook?workspace=${encodeURIComponent(OTHER)}`)).json()).toMatchObject({ workspace: OTHER, chapters: [] });
    // a chapter of the other workspace reaches only the view that belongs to it
    await openChapter(ide.playbooks, { workspace: OTHER, repo: root, label: 'Docs', color: '#1971c2' }, { title: 'Other work', plan: 'Docs' });
    await other.next(book => book.workspace === OTHER && book.chapters.length === 1);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(shown.books.some(book => book.workspace === OTHER)).toBe(false);
    // the first view moves to a window of the other workspace: it gets that playbook at once
    shown.socket.send(JSON.stringify({ type: 'context', workspace: OTHER }));
    await shown.next(book => book.workspace === OTHER && book.chapters.length === 1);
    // a relative path is no workspace: the view falls back to the one the app shows
    expect(await (await fetch(`${ide.url}/api/playbook?workspace=relative`)).json()).toMatchObject({ workspace: WORKSPACE });
    shown.socket.close();
    other.socket.close();
});

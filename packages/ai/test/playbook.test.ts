import { cpSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, test } from 'vitest';
import {
    createMcpServer, MemoryPlaybookStore, MemorySessionStore, openChapter, PLAYBOOK_INSTRUCTIONS, RemotePlaybookStore, respondToStep,
    servePlaybookStore, unwatched, type Channel, type Playbook
} from '../src/index.js';

function workspace(): string {
    const root = mkdtempSync(join(tmpdir(), 'appling-playbook-'));
    cpSync(join(import.meta.dirname, '../../../examples'), root, { recursive: true });
    return root;
}

function channels(): [Channel, Channel] {
    const listeners: [Set<(m: unknown) => void>, Set<(m: unknown) => void>] = [new Set(), new Set()];
    const end = (own: number): Channel => ({
        send: message => setTimeout(() => listeners[1 - own].forEach(l => l(structuredClone(message)))),
        onMessage: listener => {
            listeners[own].add(listener);
            return () => listeners[own].delete(listener);
        }
    });
    return [end(0), end(1)];
}

const author = { workspace: 'w', repo: '/work/shop', label: 'Generate Django', color: '#1971c2' };

test('chapters queue in order, steps get done, the user moves and watches, and the playbook survives on disk', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'appling-playbooks-'));
    const store = new MemoryPlaybookStore(folder);
    const changes: Playbook[] = [];
    store.onChange(book => changes.push(book));
    const first = await store.open({ ...author, title: 'Invoices', plan: 'Add an invoice', steps: [{ elements: ['sales.Invoice'], change: 'add', note: 'The entity' }] });
    await store.move('w', { chapter: first.id, step: 0 });
    const second = await store.open({ ...author, label: 'Codex', title: 'Payments', plan: 'Pay invoices', refs: [first.id] });
    // a chapter added while the user watches another one leaves the position alone
    expect((await store.read('w')).position).toEqual({ chapter: first.id, step: 0 });
    expect((await store.read('w')).chapters.map(c => c.title)).toEqual(['Invoices', 'Payments']);
    await expect(store.open({ ...author, title: 'x', plan: 'y', refs: ['nope'] })).rejects.toThrow(/No chapter nope/);
    await expect(store.open({ ...author, title: 'x', plan: 'y', steps: [{ elements: [], change: 'paint' as never, note: '' }] })).rejects.toThrow(/Unknown change/);

    await store.add(second.id, [{ elements: ['sales.pay'], change: 'add', note: 'The action' }, { elements: ['sales.Order.total'], change: 'change', note: 'Totals' }]);
    expect((await store.done(second.id, [1], 'with a guard')).steps.map(s => [s.n, s.state, s.doneNote])).toEqual([[1, 'done', 'with a guard'], [2, 'planned', undefined]]);
    await expect(store.done(second.id, [9])).rejects.toThrow(/no step 9/);
    await store.close(second.id, 'Invoices can be paid');
    await expect(store.add(second.id, [{ elements: [], change: 'show', note: 'late' }])).rejects.toThrow(/closed/);

    expect(unwatched(await store.read('w'))).toEqual({ total: 2, sessions: {}, repos: { '/work/shop': 2 } });
    await store.move('w', { chapter: first.id, step: 1 });
    expect(unwatched(await store.read('w')).total).toBe(1);
    await store.move('w', { chapter: second.id, step: 99 });
    expect((await store.read('w')).position).toEqual({ chapter: second.id, step: 2 });
    expect(unwatched(await store.read('w')).total).toBe(0);
    // stepping back keeps them watched
    await store.move('w', { chapter: first.id, step: 0 });
    expect(unwatched(await store.read('w')).total).toBe(0);
    expect(changes.at(-1)!.position).toEqual({ chapter: first.id, step: 0 });

    expect(readdirSync(folder)).toHaveLength(1);
    const reloaded = new MemoryPlaybookStore(folder);
    expect(await reloaded.read('w')).toEqual(await store.read('w'));
    expect((await reloaded.read('other')).chapters).toEqual([]);
});

test('openChapter writes a chapter without MCP, and a store in another process is reached over a channel', async () => {
    const [main, child] = channels();
    const store = new MemoryPlaybookStore();
    servePlaybookStore(store, main);
    const remote = new RemotePlaybookStore(child);
    const seen: Playbook[] = [];
    remote.onChange(book => seen.push(book));

    const chapter = await openChapter(remote, author, { title: 'Generate', plan: 'One app per module', steps: [{ elements: ['sales.Order'], change: 'show', note: 'models.py' }] });
    await chapter.add([{ elements: ['sales.place'], change: 'show', note: 'views.py' }]);
    await chapter.done([1, 2]);
    await chapter.close('12 files');
    expect(await chapter.read()).toMatchObject({ title: 'Generate', status: 'closed', result: '12 files', steps: [{ state: 'done' }, { state: 'done' }] });
    await expect(remote.done(chapter.id, [5])).rejects.toThrow(/no step 5/);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(seen.at(-1)!.chapters[0].status).toBe('closed');
});

async function connect(root: string, sessions: MemorySessionStore, playbook: MemoryPlaybookStore, id: string) {
    const client = new Client({ name: 'agent', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([createMcpServer(root, { session: { id, store: sessions, playbook } }).connect(serverTransport), client.connect(clientTransport)]);
    const call = async (name: string, args: Record<string, unknown> = {}) => JSON.parse(((await client.callTool({ name, arguments: args })).content as { text: string }[])[0].text);
    return { client, call };
}

test('sessions write the playbook over MCP, see where the user is, and get the user\'s responses as messages', async () => {
    const root = workspace();
    const sessions = new MemorySessionStore();
    const playbooks = new MemoryPlaybookStore();
    const a = (await sessions.open({ name: 'Claude Code', repo: root, workspace: 'team', label: 'Invoices' })).session;
    const b = (await sessions.open({ name: 'Codex', repo: root, workspace: 'team' })).session;
    const agentA = await connect(root, sessions, playbooks, a.id);
    const agentB = await connect(root, sessions, playbooks, b.id);
    expect(agentA.client.getInstructions()).toContain(PLAYBOOK_INSTRUCTIONS);

    const opened = await agentA.call('playbook_open_chapter', {
        title: 'Invoices', plan: 'Add invoices to sales',
        steps: [{ elements: ['sales.Invoice'], change: 'add', note: 'The entity' }, { elements: ['sales.Order'], change: 'change', note: 'Link orders' }]
    });
    expect(opened).toMatchObject({ chapter: { title: 'Invoices', by: 'Invoices', steps: [{ n: 1, state: 'planned' }, { n: 2 }] }, watching: null, unwatched: 1 });
    const chapter = opened.chapter.id as string;
    expect((await playbooks.read('team')).chapters[0]).toMatchObject({ session: a.id, color: a.color, label: 'Invoices' });

    // The user watches A's chapter; B's chapter queues after it.
    await playbooks.move('team', { chapter, step: 1 });
    const later = await agentB.call('playbook_open_chapter', { title: 'Invoice emails', plan: 'Mail the invoice', refs: [chapter] });
    expect(later).toMatchObject({ watching: { chapter, title: 'Invoices', step: 1, of: 2 }, queued: [{ title: 'Invoice emails', by: 'Codex' }] });
    expect(await agentB.call('playbook_step_done', { chapter, steps: [1] })).toMatchObject({ error: expect.stringMatching(/belongs to Invoices/) });

    expect((await agentA.call('playbook_step_done', { steps: [1], note: 'done' })).chapter.steps[0]).toMatchObject({ state: 'done' });
    expect((await agentA.call('playbook_add_steps', { steps: [{ elements: ['sales.Invoice.total'], change: 'add', note: 'Unplanned' }] })).chapter.steps).toHaveLength(3);

    const response = await respondToStep(playbooks, sessions, chapter, 2, { kind: 'reject', text: 'Keep orders as they are' });
    expect(response.delivered).toBe(true);
    const next = await agentA.call('playbook_read');
    expect(next.messages).toMatch(/1 unread/);
    expect(next.chapters[0].steps[1].responses).toMatchObject([{ kind: 'reject', text: 'Keep orders as they are' }]);
    expect((await agentA.call('session_inbox')).messages).toMatchObject([{ from: 'user', fromLabel: 'User', text: expect.stringMatching(/rejected step 2 \("Link orders"\).*Keep orders as they are/) }]);

    expect((await agentA.call('playbook_close_chapter', { result: 'Invoices exist' })).chapter).toMatchObject({ status: 'closed', result: 'Invoices exist' });
    expect(await agentA.call('playbook_close_chapter', { result: 'again' })).toMatchObject({ error: expect.stringMatching(/no open chapter/) });

    // The chapter stays after its session ended; a response then only goes into the playbook.
    await sessions.end(a.id);
    expect((await respondToStep(playbooks, sessions, chapter, 1, { kind: 'approve' })).delivered).toBe(false);
    expect((await playbooks.read('team')).chapters[0].steps[0].responses).toMatchObject([{ kind: 'approve' }]);
});

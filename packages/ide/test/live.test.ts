import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import { LiveTracker } from '../src/server/live.js';
import { startIde, type Ide } from '../src/server/server.js';
import { snapshot } from '../src/server/workspace.js';
import type { AgentView, LiveChanges, Proposal } from '../src/shared/live.js';

const SHOP = 'module shop {\n  entity Order {\n    total: Int\n  }\n}\n';

function workspace(): string {
    const root = mkdtempSync(join(tmpdir(), 'appling-ide-live-'));
    writeFileSync(join(root, 'shop.appling'), SHOP);
    return root;
}

describe('LiveTracker', () => {
    test('marks the changes of every write against the baseline, per file, until they are accepted', async () => {
        const root = workspace();
        const emitted: LiveChanges[] = [];
        const live = new LiveTracker(root, state => emitted.push(state));
        writeFileSync(join(root, 'shop.appling'), SHOP.replace('total: Int', 'total: Int\n    note: String?'));
        writeFileSync(join(root, 'crm.appling'), 'module crm {\n  entity Account {\n    name: String\n  }\n}\n');
        const state = await live.update(await snapshot(root));
        expect(state.files.map(f => [f.path, f.status]).sort()).toEqual([['crm.appling', 'added'], ['shop.appling', 'modified']]);
        expect(state.files.find(f => f.path === 'shop.appling')!.elements).toEqual(['shop.Order.note']);
        expect(state.files.find(f => f.path === 'shop.appling')!.before).toBe(SHOP);
        expect(state.diff.added).toContain('crm.Account');
        expect(state.files.every(f => f.sessions.length === 0)).toBe(true);
        expect(emitted.at(-1)).toBe(state);

        const accepted = await live.acknowledge(['crm.appling']);
        expect(accepted.files.map(f => f.path)).toEqual(['shop.appling']);
        expect(accepted.diff.added).toEqual(['shop.Order.note']);
        expect((await live.acknowledge()).files).toEqual([]);
    });

    test('ghosts removed elements and reverts a file to the text last accepted', async () => {
        const root = workspace();
        const live = new LiveTracker(root);
        writeFileSync(join(root, 'shop.appling'), 'module shop {\n}\n');
        const state = await live.update(await snapshot(root));
        expect(state.diff.removed).toContain('shop.Order');
        expect(state.ghosts.nodes.map(n => n.qn)).toContain('shop.Order');
        expect(state.files[0].elements).toContain('shop.Order');

        expect(live.revert('shop.appling')).toEqual({ ok: true });
        expect(readFileSync(join(root, 'shop.appling'), 'utf8')).toBe(SHOP);
        expect((await live.update(await snapshot(root))).files).toEqual([]);
        expect(live.revert('../outside.appling').ok).toBe(false);
    });

    test('a reverted new file is deleted', async () => {
        const root = workspace();
        const live = new LiveTracker(root);
        writeFileSync(join(root, 'extra.appling'), 'module extra {\n}\n');
        await live.update(await snapshot(root));
        live.revert('extra.appling');
        expect(existsSync(join(root, 'extra.appling'))).toBe(false);
    });

    test('attributes files to sessions, even before the watcher saw the write', async () => {
        const root = workspace();
        const live = new LiveTracker(root);
        await live.update(await snapshot(root));
        writeFileSync(join(root, 'shop.appling'), SHOP.replace('Int', 'Decimal'));
        await live.attribute('s1', ['shop.appling']);
        const state = await live.update(await snapshot(root));
        expect(state.files[0]).toMatchObject({ path: 'shop.appling', sessions: ['s1'] });
        expect(state.diff.changed).toContain('shop.Order.total');
    });

    test("the user's own saves are not marked, unless they land on an unseen change", async () => {
        const root = workspace();
        const live = new LiveTracker(root);
        const own = SHOP.replace('Int', 'Decimal');
        live.own('shop.appling', own);
        writeFileSync(join(root, 'shop.appling'), own);
        expect((await live.update(await snapshot(root))).files).toEqual([]);

        writeFileSync(join(root, 'shop.appling'), SHOP);
        expect((await live.update(await snapshot(root))).files).toHaveLength(1);
        live.own('shop.appling', SHOP.replace('Int', 'String'));
        writeFileSync(join(root, 'shop.appling'), SHOP.replace('Int', 'String'));
        expect((await live.update(await snapshot(root))).files[0].before).toBe(own);
    });
});

describe('the IDE server', () => {
    let ide: Ide;
    let root: string;
    const unseen: number[] = [];

    beforeAll(async () => {
        root = mkdtempSync(join(tmpdir(), 'appling-ide-live-server-'));
        cpSync(join(import.meta.dirname, '../../../examples'), root, { recursive: true });
        ide = await startIde(root, 0, { onUnseen: count => unseen.push(count) });
    });

    afterAll(() => ide.close());

    type Message = { type: string, [key: string]: unknown };

    async function events() {
        const socket = new WebSocket(ide.url.replace('http', 'ws') + '/events', { origin: ide.url });
        const messages: Message[] = [];
        const waiters: (() => void)[] = [];
        socket.on('message', data => {
            messages.push(JSON.parse(data.toString()));
            waiters.splice(0).forEach(w => w());
        });
        await new Promise(resolve => socket.on('open', resolve));
        /** The latest message that matches, among those from the index `from` on. */
        const next = async (match: (m: Message) => boolean, from = 0) => {
            for (;;) {
                const found = messages.slice(from).findLast(match);
                if (found) return found;
                await new Promise<void>(done => waiters.push(done));
            }
        };
        return { socket, next, messages };
    }

    async function agent(token: string) {
        const client = new Client({ name: 'agent', version: '1' });
        await client.connect(new StreamableHTTPClientTransport(new URL(ide.mcp), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
        const call = async (name: string, args: Record<string, unknown> = {}) => JSON.parse(((await client.callTool({ name, arguments: args })).content as { text: string }[])[0].text);
        return { client, call };
    }

    test("a session's visual tools draw on the repo's canvas and its proposals are decided in the app", async () => {
        const watch = await events();
        const { session, token } = await ide.sessions.open({ name: 'Claude Code', repo: root });
        const a = await agent(token);
        expect(a.client.getInstructions()).toContain("project's canvas");
        expect(a.client.getServerCapabilities()?.experimental).toBeUndefined();

        expect(await a.call('visualize', { view: 'node', focus: ['sales.Order'], title: 'Orders' })).toEqual({ shown: true });
        expect(await a.call('visual_bubble', { target: 'sales.Order.status', text: 'Moves through the order flow' })).toEqual({ placed: true });
        expect(await a.call('visual_status', { text: 'Explaining orders', done: 1, total: 3 })).toEqual({ shown: true });
        const view = (await watch.next(m => m.type === 'agent-view' && (m.view as AgentView).steps.length > 0)).view as AgentView;
        expect(view).toMatchObject({ session: session.id, show: { view: 'node', focus: ['sales.Order'], title: 'Orders' }, bubbles: [{ target: 'sales.Order.status' }] });

        watch.socket.send(JSON.stringify({ type: 'context', selection: 'sales.Order', watching: session.id }));
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(await a.call('visual_selection')).toMatchObject({ open: true, qn: 'sales.Order', view: { view: 'node' } });

        const proposed = a.call('propose_edits', { operations: [{ op: 'add', parent: 'sales.Order', source: 'note: String?' }], summary: 'Add a note' });
        const proposal = ((await watch.next(m => m.type === 'proposals' && (m.proposals as Proposal[]).length > 0)).proposals as Proposal[])[0];
        expect(proposal).toMatchObject({ session: session.id, review: { summary: 'Add a note', graph: { added: ['sales.Order.note'] } } });
        expect((await fetch(`${ide.url}/api/proposals/nope`, { method: 'POST', body: JSON.stringify({ decision: { accepted: true } }) })).status).toBe(404);
        await fetch(`${ide.url}/api/proposals/${proposal.id}`, { method: 'POST', body: JSON.stringify({ decision: { accepted: true } }) });
        expect(await proposed).toMatchObject({ accepted: true, ok: true });

        // The written change is marked live, attributed to the session, until it is accepted.
        const live = (await watch.next(m => m.type === 'live' && (m.live as LiveChanges).files.some(f => f.sessions.includes(session.id)))).live as LiveChanges;
        expect(live.diff.added).toContain('sales.Order.note');
        expect(unseen.at(-1)).toBe(1);

        // A plain write by any other process is marked too, without a session.
        writeFileSync(join(root, 'crm.appling'), readFileSync(join(root, 'crm.appling'), 'utf8') + '\n');
        const both = (await watch.next(m => m.type === 'live' && (m.live as LiveChanges).files.length === 2)).live as LiveChanges;
        expect(both.files.find(f => f.path === 'crm.appling')!.sessions).toEqual([]);

        const accepted = await (await fetch(`${ide.url}/api/live/accept`, { method: 'POST', body: JSON.stringify({ paths: ['sales.appling'] }) })).json() as LiveChanges;
        expect(accepted.files.map(f => f.path)).toEqual(['crm.appling']);
        const reverted = watch.messages.length;
        expect((await fetch(`${ide.url}/api/live/revert`, { method: 'POST', body: JSON.stringify({ path: 'crm.appling' }) })).ok).toBe(true);
        await watch.next(m => m.type === 'live' && (m.live as LiveChanges).files.length === 0, reverted);
        expect(unseen.at(-1)).toBe(0);

        // An ended session's views go, and its waiting proposals are rejected.
        const asked = watch.messages.length;
        const waiting = a.call('propose_edits', { operations: [{ op: 'add', parent: 'sales.Order', source: 'memo: String?' }], summary: 'Add a memo' });
        await watch.next(m => m.type === 'proposals' && (m.proposals as Proposal[]).length > 0, asked);
        await ide.sessions.end(session.id);
        expect(await waiting).toMatchObject({ accepted: false, comment: 'The session ended.' });
        await watch.next(m => m.type === 'agent-view' && m.ended === true);
        watch.socket.close();
    }, 30000);

    test("a question typed in a session's view reaches its inbox, and its answer shows in the view", async () => {
        const watch = await events();
        const { session, token } = await ide.sessions.open({ name: 'Claude Code', repo: root });
        const a = await agent(token);
        await a.call('visualize', { view: 'node', focus: ['sales.Order'] });
        const ask = (text: unknown, id = session.id) => fetch(`${ide.url}/api/sessions/${encodeURIComponent(id)}/ask`, { method: 'POST', body: JSON.stringify({ text }) });
        expect((await ask('  ')).status).toBe(400);
        expect((await ask('Why?', 'nope')).status).toBe(404);
        expect(await (await ask('Why does an order need a customer?')).json()).toEqual({ delivered: true });
        const asked = (await watch.next(m => m.type === 'agent-view' && !!(m.view as AgentView).questions?.length)).view as AgentView;
        expect(asked.questions).toEqual(['Why does an order need a customer?']);

        // the next tool result says a message waits; the inbox holds it, from User
        expect((await a.call('visual_selection')).messages).toContain('1 unread message');
        const { messages } = await a.call('session_inbox');
        expect(messages).toMatchObject([{ from: 'user', fromLabel: 'User', text: expect.stringContaining('Why does an order need a customer?') }]);
        expect(await a.call('visual_reply', { text: 'Every order is billed to one.' })).toEqual({ sent: true });
        const answered = (await watch.next(m => m.type === 'agent-view' && (m.view as AgentView).replies.length > 0)).view as AgentView;
        expect(answered.replies).toEqual(['Every order is billed to one.']);
        await ide.sessions.end(session.id);
        watch.socket.close();
    }, 30000);
});

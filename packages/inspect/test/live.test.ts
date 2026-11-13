import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import { LiveTracker } from '../src/server/live.js';
import { startInspect, type Inspect } from '../src/server/server.js';
import { snapshot } from '../src/server/workspace.js';
import type { AgentView, LiveChanges } from '../src/shared/live.js';

const SHOP = 'module shop {\n  entity Order {\n    total: Int\n  }\n}\n';

function workspace(): string {
    const root = mkdtempSync(join(tmpdir(), 'appling-inspect-live-'));
    writeFileSync(join(root, 'shop.appling'), SHOP);
    return root;
}

function git(root: string, ...args: string[]): void {
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'ignore' });
}

describe('LiveTracker', () => {
    test('marks the changes of every write against the baseline, per file', async () => {
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

        writeFileSync(join(root, 'shop.appling'), SHOP);
        rmSync(join(root, 'crm.appling'));
        expect((await live.update(await snapshot(root))).files).toEqual([]);
    });

    test('ghosts removed elements', async () => {
        const root = workspace();
        const live = new LiveTracker(root);
        writeFileSync(join(root, 'shop.appling'), 'module shop {\n}\n');
        const state = await live.update(await snapshot(root));
        expect(state.diff.removed).toContain('shop.Order');
        expect(state.ghosts.nodes.map(n => n.qn)).toContain('shop.Order');
        expect(state.files[0].elements).toContain('shop.Order');
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

    test('in git, marks the changes since HEAD and follows HEAD after a commit', async () => {
        const root = workspace();
        git(root, 'init', '-q');
        git(root, 'add', '.');
        git(root, 'commit', '-q', '-m', 'shop');
        const changed = SHOP.replace('Int', 'Decimal');
        writeFileSync(join(root, 'shop.appling'), changed);
        writeFileSync(join(root, 'crm.appling'), 'module crm {\n}\n');
        // the server started after the edits: they are still marked, as git status lists them
        const live = new LiveTracker(root);
        await live.followHead();
        const state = await live.update(await snapshot(root));
        expect(state.files.map(f => [f.path, f.status]).sort()).toEqual([['crm.appling', 'added'], ['shop.appling', 'modified']]);
        expect(state.files.find(f => f.path === 'shop.appling')!.before).toBe(SHOP);

        git(root, 'add', 'shop.appling');
        git(root, 'commit', '-q', '-m', 'decimal');
        const committed = await live.followHead();
        expect(committed.files.map(f => f.path)).toEqual(['crm.appling']);
        expect(committed.diff.changed).toEqual([]);
    });
});

describe('the inspect server', () => {
    let inspect: Inspect;
    let root: string;

    beforeAll(async () => {
        root = mkdtempSync(join(tmpdir(), 'appling-inspect-live-server-'));
        cpSync(join(import.meta.dirname, '../../../examples'), root, { recursive: true });
        inspect = await startInspect(root);
    });

    afterAll(() => inspect.close());

    type Message = { type: string, [key: string]: unknown };

    async function events() {
        const socket = new WebSocket(inspect.url.replace('http', 'ws') + '/events', { origin: inspect.url });
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
        await client.connect(new StreamableHTTPClientTransport(new URL(inspect.mcp), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
        const call = async (name: string, args: Record<string, unknown> = {}) => JSON.parse(((await client.callTool({ name, arguments: args })).content as { text: string }[])[0].text);
        return { client, call };
    }

    test("a session's visual tools draw on the repo's canvas and its writes are marked live", async () => {
        const watch = await events();
        const { session, token } = await inspect.sessions.open({ name: 'Claude Code', repo: root });
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

        // A write through the session's tool calls is marked live and attributed to the session.
        expect(await a.call('edit', { operation: { op: 'add', parent: 'sales.Order', source: 'note: String?' } })).toMatchObject({ ok: true });
        const live = (await watch.next(m => m.type === 'live' && (m.live as LiveChanges).files.some(f => f.sessions.includes(session.id)))).live as LiveChanges;
        expect(live.diff.added).toContain('sales.Order.note');

        // A plain write by any other process is marked too, without a session.
        writeFileSync(join(root, 'crm.appling'), readFileSync(join(root, 'crm.appling'), 'utf8') + '\n');
        const both = (await watch.next(m => m.type === 'live' && (m.live as LiveChanges).files.length === 2)).live as LiveChanges;
        expect(both.files.find(f => f.path === 'crm.appling')!.sessions).toEqual([]);


        // Writing a file back to the baseline clears its mark.
        writeFileSync(join(root, 'crm.appling'), readFileSync(join(root, 'crm.appling'), 'utf8').slice(0, -1));
        await watch.next(m => m.type === 'live' && (m.live as LiveChanges).files.length === 1, watch.messages.length);

        // An ended session's views go.
        await inspect.sessions.end(session.id);
        await watch.next(m => m.type === 'agent-view' && m.ended === true);
        watch.socket.close();
    }, 30000);

    test("a question typed in a session's view reaches its inbox, and its answer shows in the view", async () => {
        const watch = await events();
        const { session, token } = await inspect.sessions.open({ name: 'Claude Code', repo: root });
        const a = await agent(token);
        await a.call('visualize', { view: 'node', focus: ['sales.Order'] });
        const ask = (text: unknown, id = session.id) => fetch(`${inspect.url}/api/sessions/${encodeURIComponent(id)}/ask`, { method: 'POST', body: JSON.stringify({ text }) });
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
        await inspect.sessions.end(session.id);
        watch.socket.close();
    }, 30000);
});

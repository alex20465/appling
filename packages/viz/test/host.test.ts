import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { WebSocket } from 'ws';
import type { Graph } from '@appling/model';
import { Visualizer, type Ask, type HostMessage } from '../src/index.js';

const GRAPH: Graph = { nodes: [], edges: [] } as unknown as Graph;

class FakeWindow extends EventEmitter {
    killed = false;
    kill() {
        this.killed = true;
    }
}

function host() {
    const urls: string[] = [];
    const windows: FakeWindow[] = [];
    const opened: [string, number][] = [];
    const root = mkdtempSync(join(tmpdir(), 'appling-viz-'));
    const visualizer = new Visualizer({
        root,
        graph: async () => GRAPH,
        edit: (file, line) => { opened.push([file, line]); },
        launch: url => {
            urls.push(url);
            windows.push(new FakeWindow());
            return windows.at(-1)!;
        }
    });
    return { visualizer, urls, windows, opened, root };
}

/** Connects like the window does and collects what the host sends. */
async function connect(url: string, origin = new URL(url).origin) {
    const { host, search } = new URL(url);
    const ws = new WebSocket(`ws://${host}/events${search}`, { origin });
    const received: HostMessage[] = [];
    ws.on('message', data => received.push(JSON.parse(data.toString())));
    await new Promise((done, fail) => {
        ws.once('open', done);
        ws.once('error', fail);
    });
    const next = async (type: HostMessage['type']) => {
        for (let i = 0; i < 100 && !received.some(m => m.type === type); i++) await new Promise(done => setTimeout(done, 10));
        return received.find(m => m.type === type);
    };
    return { ws, received, next, send: (message: unknown) => ws.send(JSON.stringify(message)) };
}

test('showing opens the window once, and a connecting window gets the graph and the view', async () => {
    const { visualizer, urls } = host();
    await visualizer.show({ view: 'machine', focus: ['sales.OrderFlow'], title: 'Order lifecycle' });
    await visualizer.show({ view: 'action', focus: ['sales.PlaceOrder'] });
    expect(urls).toHaveLength(1);
    const window = await connect(urls[0]);
    expect(await window.next('graph')).toEqual({ type: 'graph', graph: GRAPH });
    expect(await window.next('show')).toEqual({ type: 'show', show: { view: 'action', focus: ['sales.PlaceOrder'] } });
    window.ws.close();
    await visualizer.close();
});

test('selections and questions from the window reach the host', async () => {
    const { visualizer, urls } = host();
    const asks: Ask[] = [];
    visualizer.onAsk(ask => asks.push(ask));
    await visualizer.show({ view: 'machine', focus: ['sales.OrderFlow'] });
    const window = await connect(urls[0]);
    await window.next('show');
    const view = { view: 'machine', focus: ['sales.OrderFlow'] };
    window.send({ type: 'select', qn: 'sales.OrderStatus.placed', view });
    window.send({ type: 'ask', text: 'Why can this not be cancelled?' });
    for (let i = 0; i < 100 && !asks.length; i++) await new Promise(done => setTimeout(done, 10));
    expect(visualizer.selection()).toEqual({ open: true, qn: 'sales.OrderStatus.placed', view });
    expect(asks).toEqual([{ id: expect.any(String), text: 'Why can this not be cancelled?', selected: 'sales.OrderStatus.placed', view }]);
    expect(visualizer.reply('Because it is paid.', asks[0].id)).toBe(true);
    expect(await window.next('reply')).toEqual({ type: 'reply', text: 'Because it is paid.', askId: asks[0].id });
    window.ws.close();
    await visualizer.close();
});

test('node views add up and keep their bubbles, another view drops them, and a file reference opens in the editor', async () => {
    const { visualizer, urls, opened, root } = host();
    const note = { target: 'sales.Order.status', text: 'Moves through OrderFlow' };
    expect(visualizer.bubble(note)).toBe(false);
    await visualizer.show({ view: 'node', focus: ['sales.Order'] });
    expect(visualizer.bubble(note)).toBe(true);
    await visualizer.show({ view: 'node', focus: ['sales.Cancel'], title: 'Cancelling' });
    const window = await connect(urls[0]);
    expect(await window.next('show')).toEqual({ type: 'show', show: { view: 'node', focus: ['sales.Order', 'sales.Cancel'], title: 'Cancelling' } });
    expect(await window.next('bubble')).toEqual({ type: 'bubble', bubble: note });
    window.send({ type: 'open', file: '../shop/models.py', line: 14 });
    for (let i = 0; i < 100 && !opened.length; i++) await new Promise(done => setTimeout(done, 10));
    expect(opened).toEqual([[join(root, '../shop/models.py'), 14]]);
    window.ws.close();

    await visualizer.show({ view: 'machine', focus: ['sales.OrderFlow'] });
    const again = await connect(urls[0]);
    await again.next('show');
    await new Promise(done => setTimeout(done, 20));
    expect(again.received.some(m => m.type === 'bubble')).toBe(false);
    again.ws.close();
    await visualizer.close();
});

test('a review resolves with the decision, and closing the window rejects the open one', async () => {
    const { visualizer, urls, windows } = host();
    const review = { summary: 'Add a phone number', hunks: [], graph: { added: ['crm.Account.phone'], removed: [], changed: [] } };
    const accepted = visualizer.review(review);
    await new Promise(done => setTimeout(done, 10));
    const window = await connect(urls[0]);
    const shown = await window.next('review');
    expect(shown).toMatchObject({ type: 'review', review });
    window.send({ type: 'decide', id: shown!.type === 'review' && shown!.id, decision: { accepted: true } });
    expect(await accepted).toEqual({ accepted: true });
    expect(await window.next('reviewed')).toBeDefined();

    const pending = visualizer.review(review);
    await new Promise(done => setTimeout(done, 10));
    windows[0].emit('exit');
    expect(await pending).toEqual({ accepted: false, comment: 'The window was closed.' });
    expect(visualizer.reply('anyone?')).toBe(false);
    window.ws.close();
    await visualizer.close();
});

test('only the served window with its token may connect', async () => {
    const { visualizer, urls } = host();
    await visualizer.show({ view: 'node', focus: ['crm'] });
    const url = new URL(urls[0]);
    await expect(connect(`http://${url.host}/?token=wrong`)).rejects.toThrow();
    await expect(connect(urls[0], 'http://evil.example')).rejects.toThrow();
    await visualizer.close();
});

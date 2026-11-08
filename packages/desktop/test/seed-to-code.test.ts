import { afterEach, expect, test, vi } from 'vitest';
import { connectDesktop } from '../../vscode/src/desktop-bridge.js';
import type { ImplementationState } from '../../vscode/src/implementation.js';
import { CodeBridge, openMessage, parseExtensionMessage } from '../src/code-bridge.js';
import { CodeProxy } from '../src/code-proxy.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
    for (const step of cleanup.splice(0).reverse()) await step();
});

const STATE: ImplementationState = {
    marks: { '/repo/sales.appling': [{ line: 3, qn: 'sales.Order', state: 'implemented', outstanding: false }] },
    links: { '/repo/out/models.py': [{ qn: 'sales.Order', start: 4, end: 9 }] }
};

test('element messages are parsed strictly; code opens inside the repo or next to it only', () => {
    expect(parseExtensionMessage('{"type":"element","qn":"sales.Order"}')).toEqual({ type: 'element', qn: 'sales.Order' });
    expect(parseExtensionMessage('{"type":"element","qn":"x\\"; rm"}')).toBeUndefined();
    expect(parseExtensionMessage('{"type":"element"}')).toBeUndefined();
    expect(openMessage('/w/repo', { path: 'out/models.py', start: 4, end: 9 })).toEqual({ type: 'open', path: '/w/repo/out/models.py', start: 4, end: 9 });
    expect(openMessage('/w/repo', { path: '../app/models.py', start: 4 })).toEqual({ type: 'open', path: '/w/app/models.py', start: 4, end: 4 });
    expect(openMessage('/w/repo', { path: '../../etc/passwd', start: 1 })).toBeUndefined();
    expect(openMessage('/w/repo', { path: 'a.py', start: 0 })).toBeUndefined();
});

test('the bridge gives the extension the implementation state, opens code and shows elements the CodeLens asks for', async () => {
    const elements: [string, string][] = [];
    const bridge = new CodeBridge({ onCursor: () => undefined, onElement: (repo, qn) => elements.push([repo, qn]) });
    const proxy = new CodeProxy({ bridge: (req, socket, head) => bridge.upgrade(req, socket, head) });
    await proxy.listen();
    cleanup.push(() => proxy.close(), () => bridge.close());
    const token = bridge.token('/repo');
    // the state that came before the extension connected is sent on hello
    bridge.implementation('/repo', STATE);
    const states: ImplementationState[] = [];
    const opened: [string, number, number][] = [];
    const client = connectDesktop({
        url: proxy.bridgeUrl, token, WebSocket: globalThis.WebSocket,
        editor: {
            onCursor: () => ({ dispose: () => undefined }), reveal: () => undefined, diff: () => undefined,
            implementation: state => { states.push(state); },
            open: (path, start, end) => { opened.push([path, start, end]); }
        }
    });
    cleanup.push(() => client.dispose());
    await client.welcomed;
    await vi.waitFor(() => expect(states).toEqual([STATE]));

    const next = { ...STATE, marks: {} };
    bridge.implementation('/repo', next);
    await vi.waitFor(() => expect(states.at(-1)).toEqual(next));
    bridge.send('/repo', openMessage('/repo', { path: 'out/models.py', start: 4, end: 9 })!);
    await vi.waitFor(() => expect(opened).toEqual([['/repo/out/models.py', 4, 9]]));
    expect(client.showElement('sales.Order')).toBe(true);
    await vi.waitFor(() => expect(elements).toEqual([['/repo', 'sales.Order']]));
});

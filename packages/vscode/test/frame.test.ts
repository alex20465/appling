import { expect, test } from 'vitest';
import { clientUrl, panelAction, panelHtml, THEME_TOKENS } from '../src/frame.js';

test('requests of the inspector client stay inside the project', () => {
    expect(panelAction('/w/shop', { type: 'openSource', uri: 'file:///w/shop/m/sales.appling', start: 3, end: 9 })).toEqual({ type: 'source', path: '/w/shop/m/sales.appling', start: 3, end: 9 });
    expect(panelAction('/w/shop', { type: 'openSource', uri: 'file:///etc/passwd.appling', start: 0, end: 0 })).toBeUndefined();
    expect(panelAction('/w/shop', { type: 'openSource', uri: 'file:///w/shop/notes.txt', start: 0, end: 0 })).toBeUndefined();
    expect(panelAction('/w/shop', { type: 'openTextDiff', path: 'sales.appling', rev: 'HEAD~1', line: 2 })).toEqual({ type: 'diff', path: '/w/shop/sales.appling', before: '/w/shop/sales.appling', rev: 'HEAD~1', line: 2 });
    expect(panelAction('/w/shop', { type: 'openTextDiff', path: 'sales.appling', rev: '--output=x' })).toBeUndefined();
    expect(panelAction('/w/shop', { type: 'focusSession', session: 's1' })).toEqual({ type: 'focusSession', session: 's1' });
    expect(panelAction('/w/shop', 'openCode')).toBeUndefined();
});

test('the tab embeds the client of the server it reaches, and allows only that frame', () => {
    const src = clientUrl('http://localhost:41234');
    expect(src).toBe('http://localhost:41234/?host=frame');
    const html = panelHtml(src, 'n0nce');
    expect(html).toContain("frame-src http://localhost:41234; script-src 'nonce-n0nce'");
    expect(html).toContain('src="http://localhost:41234/?host=frame"');
    expect(html).toContain('if (event.origin === origin) vscode.postMessage(event.data);');
});

test('the client hands its side panels to the extension: their state and which one to show, nothing that writes', () => {
    const state = { snapshot: { graph: { nodes: [], edges: [] } } };
    expect(panelAction('/repo', { type: 'panels', state })).toEqual({ type: 'panels', state });
    expect(panelAction('/repo', { type: 'panels', state: 'x' })).toBeUndefined();
    expect(panelAction('/repo', { type: 'showPanel', name: 'changes' })).toEqual({ type: 'showPanel', name: 'changes' });
    expect(panelAction('/repo', { type: 'showPanel', name: 'workbench.action.quit' })).toBeUndefined();
    for (const type of ['error', 'chooseStack', 'edit', 'openCode']) expect(panelAction('/repo', { type, message: 'x', operation: { op: 'remove', target: 'sales.Order' } })).toBeUndefined();
});

test("the tab sends VS Code's theme to the inspector: its colours and fonts for its theme tokens", () => {
    const html = panelHtml('http://127.0.0.1:4410/?host=frame', 'nonce');
    expect(html).toContain(JSON.stringify(THEME_TOKENS));
    expect(html).toContain('vscode-light');
    expect(Object.keys(THEME_TOKENS).every(token => token.startsWith('--appling-'))).toBe(true);
});

import { expect, test } from 'vitest';
import { clientUrl, panelAction, panelHtml, THEME_TOKENS } from '../src/frame.js';

test('requests of the IDE client stay inside the project', () => {
    expect(panelAction('/w/shop', { type: 'openSource', uri: 'file:///w/shop/m/sales.appling', start: 3, end: 9 })).toEqual({ type: 'source', path: '/w/shop/m/sales.appling', start: 3, end: 9 });
    expect(panelAction('/w/shop', { type: 'openSource', uri: 'file:///etc/passwd.appling', start: 0, end: 0 })).toBeUndefined();
    expect(panelAction('/w/shop', { type: 'openSource', uri: 'file:///w/shop/notes.txt', start: 0, end: 0 })).toBeUndefined();
    expect(panelAction('/w/shop', { type: 'openCode', path: 'build/shop/models.py', start: 4, end: 8 })).toEqual({ type: 'open', path: '/w/shop/build/shop/models.py', start: 4, end: 8 });
    expect(panelAction('/w/shop', { type: 'openCode', path: '../../etc/passwd', start: 1 })).toBeUndefined();
    expect(panelAction('/w/shop', { type: 'openTextDiff', path: 'sales.appling', rev: 'HEAD~1', line: 2 })).toEqual({ type: 'diff', path: '/w/shop/sales.appling', before: '/w/shop/sales.appling', rev: 'HEAD~1', line: 2 });
    expect(panelAction('/w/shop', { type: 'openTextDiff', path: 'sales.appling', rev: '--output=x' })).toBeUndefined();
    expect(panelAction('/w/shop', { type: 'focusSession', session: 's1' })).toEqual({ type: 'focusSession', session: 's1' });
    expect(panelAction('/w/shop', { type: 'showChanges', repo: '/w/crm', session: 's1' })).toEqual({ type: 'showChanges', repo: '/w/crm', session: 's1' });
    expect(panelAction('/w/shop', 'openCode')).toBeUndefined();
});

test('the tab embeds the client of the server it reaches, and allows only that frame', () => {
    const src = clientUrl('http://localhost:41234', '/w/shop.code-workspace');
    expect(src).toBe('http://localhost:41234/?host=frame&workspace=%2Fw%2Fshop.code-workspace');
    const html = panelHtml(src, 'n0nce');
    expect(html).toContain("frame-src http://localhost:41234; script-src 'nonce-n0nce'");
    expect(html).toContain('src="http://localhost:41234/?host=frame&amp;workspace=%2Fw%2Fshop.code-workspace"');
    expect(html).toContain('if (event.origin === origin) vscode.postMessage(event.data);');
});

test('the client hands its side panels to the extension: their state, which one to show, and errors', () => {
    const state = { snapshot: { graph: { nodes: [], edges: [] } } };
    expect(panelAction('/repo', { type: 'panels', state })).toEqual({ type: 'panels', state });
    expect(panelAction('/repo', { type: 'panels', state: 'x' })).toBeUndefined();
    expect(panelAction('/repo', { type: 'showPanel', name: 'changes' })).toEqual({ type: 'showPanel', name: 'changes' });
    expect(panelAction('/repo', { type: 'showPanel', name: 'workbench.action.quit' })).toBeUndefined();
    expect(panelAction('/repo', { type: 'error', message: 'No targets' })).toEqual({ type: 'error', message: 'No targets' });
    expect(panelAction('/repo', { type: 'chooseStack', selection: { mode: 'elements', elements: ['sales.Order'] } })).toEqual({ type: 'chooseStack', selection: { mode: 'elements', elements: ['sales.Order'] } });
    expect(panelAction('/repo', { type: 'chooseStack', selection: { mode: 'elements', elements: [1] } })).toBeUndefined();
});

test("the tab sends VS Code's theme to the IDE: its colours and fonts for the IDE's theme tokens", () => {
    const html = panelHtml('http://127.0.0.1:4410/?host=frame', 'nonce');
    expect(html).toContain(JSON.stringify(THEME_TOKENS));
    expect(html).toContain('vscode-light');
    expect(Object.keys(THEME_TOKENS).every(token => token.startsWith('--appling-'))).toBe(true);
});

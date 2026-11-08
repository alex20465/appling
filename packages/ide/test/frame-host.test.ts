import { expect, test } from 'vitest';
import { frameEvent, frameHooks, themeEvent, type FrameRequest } from '../src/client/frame-host.js';

test('hooks become messages to the parent, and its events reach listeners registered before or after', () => {
    const sent: FrameRequest[] = [];
    let receive: (message: unknown) => void = () => undefined;
    const hooks = frameHooks(message => sent.push(message), r => receive = r, '/work/shop.code-workspace');
    hooks.openSource!({ uri: 'file:///repo/sales.appling', start: 3, end: 9 });
    hooks.openCode!({ path: 'app/models.py', start: 4, end: 8 });
    hooks.showChanges!('/repo/crm');
    expect(sent).toEqual([
        { type: 'openSource', uri: 'file:///repo/sales.appling', start: 3, end: 9 },
        { type: 'openCode', path: 'app/models.py', start: 4, end: 8 },
        { type: 'showChanges', repo: '/repo/crm' }
    ]);
    expect(hooks.workspace!()).toBe('/work/shop.code-workspace');
    // an element the extension sends before the IDE listens waits for the listener
    receive({ type: 'element', qn: 'sales.Order' });
    const elements: string[] = [];
    hooks.onCodeElement!(qn => elements.push(qn));
    receive({ type: 'element', qn: 'crm.Customer' });
    receive({ type: 'cursor', uri: 'x', offset: 1.5 });
    expect(elements).toEqual(['sales.Order', 'crm.Customer']);
});

test('only well formed events pass', () => {
    expect(frameEvent({ type: 'cursor', uri: 'file:///a.appling', offset: 4 })).toEqual({ type: 'cursor', uri: 'file:///a.appling', offset: 4 });
    expect(frameEvent({ type: 'showChanges', session: 7 })).toEqual({ type: 'showChanges' });
    expect(frameEvent({ type: 'openSource' })).toBeUndefined();
    expect(frameEvent('element')).toBeUndefined();
});

test('the parent draws the side panels: the state goes to it, its actions reach the IDE', () => {
    const sent: FrameRequest[] = [];
    let receive: (message: unknown) => void = () => undefined;
    const hooks = frameHooks(message => sent.push(message), r => receive = r);
    hooks.panels!({ selected: 'sales.Order' } as never);
    hooks.showPanel!('code');
    hooks.showError!('No targets');
    hooks.chooseStack!({ mode: 'all' });
    expect(sent).toEqual([{ type: 'panels', state: { selected: 'sales.Order' } }, { type: 'showPanel', name: 'code' }, { type: 'error', message: 'No targets' }, { type: 'chooseStack', selection: { mode: 'all' } }]);
    const actions: unknown[] = [];
    receive({ type: 'panel', action: { type: 'select', qn: 'sales.Order' } });
    hooks.onPanelAction!(action => actions.push(action));
    receive({ type: 'panel', action: { type: 'accept' } });
    expect(actions).toEqual([{ type: 'select', qn: 'sales.Order' }, { type: 'accept' }]);
    expect(frameEvent({ type: 'panel', action: 'select' })).toBeUndefined();
});

test("a host's theme names light or dark and only the IDE's theme tokens", () => {
    expect(themeEvent({ type: 'theme', kind: 'light', tokens: { '--appling-surface': '#ffffff', '--other': 'red', '--appling-ink': 3 } }))
        .toEqual({ type: 'theme', kind: 'light', tokens: { '--appling-surface': '#ffffff' } });
    expect(themeEvent({ type: 'theme', kind: 'sepia', tokens: {} })).toBeUndefined();
    expect(themeEvent({ type: 'element', qn: 'x' })).toBeUndefined();
});

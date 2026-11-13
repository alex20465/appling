import type { PanelAction, PanelName, PanelState } from '../shared/panels.js';
import type { HostHooks } from './hooks.js';

/**
 * The hooks of a host that embeds the inspector in an iframe, opened with `?host=frame` (the VS Code extension's webview,
 * whose page relays between this frame and the extension): each hook the inspector calls is a message `{ type, ... }` to
 * the parent; the parent's `element`, `cursor` and `panel` messages reach the client's listeners, and one that arrives
 * before its listener waits for it. The parent draws the side panels (`panels`), so the client draws no inspector.
 */
export type FrameRequest =
    | { type: 'openSource', uri: string, start: number, end: number }
    | { type: 'openTextDiff', path: string, before?: string, rev: string, line?: number }
    | { type: 'focusSession', session: string }
    | { type: 'panels', state: PanelState }
    | { type: 'showPanel', name: PanelName };

export type FrameEvent =
    | { type: 'element', qn: string }
    | { type: 'cursor', uri: string, offset: number }
    | { type: 'panel', action: PanelAction };

export function frameHooks(post: (message: FrameRequest) => void, listen: (receive: (message: unknown) => void) => void): HostHooks {
    const listeners: { [T in FrameEvent['type']]?: (event: Extract<FrameEvent, { type: T }>) => void } = {};
    const waiting = new Map<FrameEvent['type'], FrameEvent>();
    const deliver = (event: FrameEvent) => {
        const listener = listeners[event.type] as ((event: FrameEvent) => void) | undefined;
        if (listener) listener(event);
        else waiting.set(event.type, event);
    };
    const on = <T extends FrameEvent['type']>(type: T, listener: (event: Extract<FrameEvent, { type: T }>) => void) => {
        (listeners as Record<string, unknown>)[type] = listener;
        const early = waiting.get(type);
        waiting.delete(type);
        if (early) listener(early as Extract<FrameEvent, { type: T }>);
    };
    listen(message => {
        const event = frameEvent(message);
        if (event) deliver(event);
    });
    return {
        openSource: location => post({ type: 'openSource', ...location }),
        openTextDiff: request => post({ type: 'openTextDiff', ...request }),
        focusSession: session => post({ type: 'focusSession', session }),
        onCodeElement: callback => on('element', event => callback(event.qn)),
        onCodeCursor: callback => on('cursor', event => callback(event.uri, event.offset)),
        panels: state => post({ type: 'panels', state }),
        onPanelAction: callback => on('panel', event => callback(event.action)),
        showPanel: name => post({ type: 'showPanel', name })
    };
}

/**
 * The host's theme: light or dark, and values for the theme tokens of `styles.css` (`--appling-surface`, `--appling-ink`
 * …) that replace the inspector's own; the VS Code extension sends the window's theme and every change of it.
 */
export interface ThemeEvent {
    type: 'theme';
    kind: 'light' | 'dark';
    tokens: Record<string, string>;
}

export function themeEvent(message: unknown): ThemeEvent | undefined {
    const m = message as Record<string, unknown> | undefined;
    if (!m || m.type !== 'theme' || (m.kind !== 'light' && m.kind !== 'dark') || !m.tokens || typeof m.tokens !== 'object') return undefined;
    const tokens = Object.entries(m.tokens as Record<string, unknown>).filter((t): t is [string, string] => /^--appling-[a-z-]+$/.test(t[0]) && typeof t[1] === 'string');
    return { type: 'theme', kind: m.kind, tokens: Object.fromEntries(tokens) };
}

/** Puts the theme on the page: the kind as `data-theme`, the tokens over the inspector's own; `appling-theme` tells the editor. */
export function applyTheme(theme: ThemeEvent, root = document.documentElement): void {
    root.dataset.theme = theme.kind;
    root.removeAttribute('style');
    for (const [name, value] of Object.entries(theme.tokens)) root.style.setProperty(name, value);
    dispatchEvent(new Event('appling-theme'));
}

/** A message from the parent, or undefined when it is none of the events. */
export function frameEvent(message: unknown): FrameEvent | undefined {
    const m = message as Record<string, unknown> | undefined;
    if (!m || typeof m !== 'object') return undefined;
    if (m.type === 'element' && typeof m.qn === 'string') return { type: 'element', qn: m.qn };
    if (m.type === 'cursor' && typeof m.uri === 'string' && Number.isInteger(m.offset)) return { type: 'cursor', uri: m.uri, offset: m.offset as number };
    // the parent is the extension, which builds the actions; only their shape is checked
    const action = m.action as { type?: unknown } | undefined;
    if (m.type === 'panel' && action && typeof action === 'object' && typeof action.type === 'string') return { type: 'panel', action: action as PanelAction };
    return undefined;
}

const params = typeof location === 'undefined' ? undefined : new URLSearchParams(location.search);
if (params?.get('host') === 'frame' && window.parent !== window) {
    const parent = window.parent;
    window.applingHost = frameHooks(
        message => parent.postMessage(message, '*'),
        receive => addEventListener('message', event => {
            if (event.source !== parent) return;
            const theme = themeEvent(event.data);
            if (theme) applyTheme(theme);
            else receive(event.data);
        })
    );
}

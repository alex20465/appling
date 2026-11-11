import { fileURLToPath } from 'node:url';
import { diffMessage, openMessage, type DiffMessage, type OpenMessage } from '@appling/ide/host-requests';
import { PANELS, type PanelName, type PanelState } from '@appling/ide/panels';
import type { GenerationSelection } from '@appling/codegen';
import type { EditOperation } from '@appling/model';
import { inside } from './projects.js';

/**
 * The IDE tab without VS Code: the webview page that embeds the project's IDE client (`?host=frame`) and relays
 * messages between it and the extension, and the checks of what the client asks for. The messages mirror
 * `packages/ide/src/client/frame-host.ts`.
 */

/** What the extension does for the IDE client, after the checks. */
export type PanelAction =
    /** Open a model file's text from offset `start` to `end`. */
    | { type: 'source', path: string, start: number, end: number }
    | OpenMessage
    | DiffMessage
    | { type: 'focusSession', session: string }
    /** What the side panels show; the extension draws them (`panels.ts`). */
    | { type: 'panels', state: PanelState }
    | { type: 'showPanel', name: PanelName }
    | { type: 'error', message: string }
    /** Generate without a target: ask for a stack first (`panels.ts`). */
    | { type: 'chooseStack', selection: GenerationSelection }
    /** An edit from the canvas's right click menu, on VS Code's documents (`panels.ts`). */
    | { type: 'edit', operation: EditOperation };

/** A request of the IDE client of the project at `root`, checked: files stay inside the project (code also next to it). */
export function panelAction(root: string, message: unknown): PanelAction | undefined {
    const m = message as Record<string, unknown> | undefined;
    if (!m || typeof m !== 'object') return undefined;
    switch (m.type) {
        case 'openSource': {
            if (typeof m.uri !== 'string' || !m.uri.startsWith('file:') || !Number.isInteger(m.start) || !Number.isInteger(m.end)) return undefined;
            const path = fileURLToPath(m.uri);
            return path.endsWith('.appling') && inside(root, path) ? { type: 'source', path, start: m.start as number, end: m.end as number } : undefined;
        }
        case 'openCode':
            return openMessage(root, m as { path: string, start: number, end?: number });
        case 'openTextDiff':
            return diffMessage(root, m as { path: string, rev: string });
        case 'focusSession':
            return typeof m.session === 'string' ? { type: 'focusSession', session: m.session } : undefined;
        case 'panels':
            return m.state && typeof m.state === 'object' && typeof (m.state as PanelState).snapshot === 'object' ? { type: 'panels', state: m.state as PanelState } : undefined;
        case 'showPanel':
            return PANELS.includes(m.name as PanelName) ? { type: 'showPanel', name: m.name as PanelName } : undefined;
        case 'error':
            return typeof m.message === 'string' ? { type: 'error', message: m.message } : undefined;
        case 'chooseStack': {
            const s = m.selection as { mode?: unknown, elements?: unknown } | undefined;
            const valid = s?.mode === 'outstanding' || s?.mode === 'all' || (s?.mode === 'elements' && Array.isArray(s.elements) && s.elements.every(e => typeof e === 'string'));
            return valid ? { type: 'chooseStack', selection: s as GenerationSelection } : undefined;
        }
        case 'edit':
            return isOperation(m.operation) ? { type: 'edit', operation: m.operation } : undefined;
    }
    return undefined;
}

/** The fields of each edit operation (`EditOperation` of `@appling/model`), all strings. */
const OPERATION_FIELDS: Record<EditOperation['op'], string[]> = { add: ['parent', 'source'], rename: ['target', 'name'], retype: ['target', 'type'], remove: ['target'], set: ['target', 'property', 'value'] };

function isOperation(value: unknown): value is EditOperation {
    const o = value as Record<string, unknown> | undefined;
    const fields = o && typeof o === 'object' && Object.hasOwn(OPERATION_FIELDS, o.op as string) ? OPERATION_FIELDS[o.op as EditOperation['op']] : undefined;
    return !!fields && fields.every(f => typeof o![f] === 'string');
}

/** The URL of the IDE client in the tab: the server's, as VS Code reaches it. */
export function clientUrl(server: string): string {
    const url = new URL('/', server);
    url.searchParams.set('host', 'frame');
    return url.toString();
}

/**
 * VS Code's theme colours and fonts (the webview's `--vscode-*` variables) for the IDE's theme tokens; the IDE keeps its
 * own accent and layer colours, in their light or dark variant.
 */
export const THEME_TOKENS: Record<string, string> = {
    '--appling-surface': '--vscode-editor-background',
    '--appling-surface-raised': '--vscode-sideBar-background',
    '--appling-surface-elevated': '--vscode-editorWidget-background',
    '--appling-surface-hover': '--vscode-list-hoverBackground',
    '--appling-line': '--vscode-panel-border',
    '--appling-line-strong': '--vscode-editorLineNumber-foreground',
    '--appling-ink': '--vscode-editor-foreground',
    '--appling-ink-soft': '--vscode-foreground',
    '--appling-ink-muted': '--vscode-descriptionForeground',
    '--appling-danger': '--vscode-errorForeground',
    '--appling-shadow': '--vscode-widget-shadow',
    '--appling-change-added': '--vscode-gitDecoration-addedResourceForeground',
    '--appling-change-changed': '--vscode-gitDecoration-modifiedResourceForeground',
    '--appling-change-removed': '--vscode-gitDecoration-deletedResourceForeground',
    '--appling-font-sans': '--vscode-font-family',
    '--appling-font-mono': '--vscode-editor-font-family'
};

/**
 * The webview page: the IDE client in a full size iframe, and a relay that passes the client's messages (only from
 * that frame and its origin) to the extension and the extension's to the frame, holding them until it loaded. It also
 * sends the frame VS Code's theme (`THEME_TOKENS`), at first and on every theme change.
 */
export function panelHtml(src: string, nonce: string): string {
    const origin = new URL(src).origin;
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'">
<style nonce="${nonce}">html, body, iframe { margin: 0; padding: 0; border: 0; width: 100%; height: 100%; overflow: hidden; display: block; }</style>
</head>
<body>
<iframe id="ide" src="${src.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}" allow="clipboard-read; clipboard-write"></iframe>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const frame = document.getElementById('ide');
const origin = ${JSON.stringify(origin)};
const tokens = ${JSON.stringify(THEME_TOKENS)};
let loaded = false;
const held = [];
const send = message => loaded ? frame.contentWindow.postMessage(message, origin) : held.push(message);
frame.addEventListener('load', () => {
    loaded = true;
    held.splice(0).forEach(message => frame.contentWindow.postMessage(message, origin));
});
addEventListener('message', event => {
    if (event.source === frame.contentWindow) {
        if (event.origin === origin) vscode.postMessage(event.data);
    } else send(event.data);
});
const theme = () => {
    const style = getComputedStyle(document.documentElement);
    const values = Object.entries(tokens).map(([token, variable]) => [token, style.getPropertyValue(variable).trim()]).filter(([, value]) => value);
    const light = document.body.classList.contains('vscode-light') || document.body.classList.contains('vscode-high-contrast-light');
    send({ type: 'theme', kind: light ? 'light' : 'dark', tokens: Object.fromEntries(values) });
};
theme();
new MutationObserver(theme).observe(document.body, { attributes: true, attributeFilter: ['class'] });
new MutationObserver(theme).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
</script>
</body>
</html>`;
}

import { fileURLToPath } from 'node:url';
import { diffMessage, type DiffMessage } from '@appling/inspect/host-requests';
import { PANELS, type PanelName, type PanelState } from '@appling/inspect/panels';
import { inside } from './projects.js';

/**
 * The inspector tab without VS Code: the webview page that embeds the project's inspector client (`?host=frame`) and
 * relays messages between it and the extension, and the checks of what the client asks for. The messages mirror
 * `packages/inspect/src/client/frame-host.ts`.
 */

/** What the extension does for the inspector client, after the checks. */
export type PanelAction =
    /** Open a model file's text from offset `start` to `end`. */
    | { type: 'source', path: string, start: number, end: number }
    | DiffMessage
    | { type: 'focusSession', session: string }
    /** What the side panels show; the extension draws them (`panels.ts`). */
    | { type: 'panels', state: PanelState }
    | { type: 'showPanel', name: PanelName };

/** A request of the inspector client of the project at `root`, checked: files stay inside the project. */
export function panelAction(root: string, message: unknown): PanelAction | undefined {
    const m = message as Record<string, unknown> | undefined;
    if (!m || typeof m !== 'object') return undefined;
    switch (m.type) {
        case 'openSource': {
            if (typeof m.uri !== 'string' || !m.uri.startsWith('file:') || !Number.isInteger(m.start) || !Number.isInteger(m.end)) return undefined;
            const path = fileURLToPath(m.uri);
            return path.endsWith('.appling') && inside(root, path) ? { type: 'source', path, start: m.start as number, end: m.end as number } : undefined;
        }
        case 'openTextDiff':
            return diffMessage(root, m as { path: string, rev: string });
        case 'focusSession':
            return typeof m.session === 'string' ? { type: 'focusSession', session: m.session } : undefined;
        case 'panels':
            return m.state && typeof m.state === 'object' && typeof (m.state as PanelState).snapshot === 'object' ? { type: 'panels', state: m.state as PanelState } : undefined;
        case 'showPanel':
            return PANELS.includes(m.name as PanelName) ? { type: 'showPanel', name: m.name as PanelName } : undefined;
    }
    return undefined;
}

/** The URL of the inspector client in the tab: the server's, as VS Code reaches it. */
export function clientUrl(server: string): string {
    const url = new URL('/', server);
    url.searchParams.set('host', 'frame');
    return url.toString();
}

/**
 * VS Code's theme colours and fonts (the webview's `--vscode-*` variables) for the inspector's theme tokens; the inspector keeps its
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
 * The webview page: the inspector client in a full size iframe, and a relay that passes the client's messages (only from
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
<iframe id="inspect" src="${src.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}" allow="clipboard-read; clipboard-write"></iframe>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const frame = document.getElementById('inspect');
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

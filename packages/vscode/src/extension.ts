import { basename, join } from 'node:path';
import { commands, Range, Selection, TextEditorRevealType, Uri, window, workspace, type ExtensionContext } from 'vscode';
import { LanguageClient, TransportKind, type LanguageClientOptions, type ServerOptions } from 'vscode-languageclient/node';
import { connectDesktop } from './desktop-bridge.js';
import { ImplementationView } from './implementation-view.js';

let client: LanguageClient | undefined;

/** Starts the bundled Appling language server for every `.appling` file in the workspace. */
export async function activate(context: ExtensionContext): Promise<void> {
    startDesktopBridge(context);
    const module = context.asAbsolutePath(join('out', 'server.js'));
    const server: ServerOptions = {
        run: { module, transport: TransportKind.ipc },
        debug: { module, transport: TransportKind.ipc, options: { execArgv: ['--nolazy', '--inspect=6009'] } }
    };
    const options: LanguageClientOptions = { documentSelector: [{ scheme: 'file', language: 'appling' }] };
    client = new LanguageClient('appling', 'Appling', server, options);
    await client.start();
}

/**
 * Inside Appling Desktop's code view: syncs the selection with the canvas, marks how far each model line is implemented
 * and links code and elements both ways (see `desktop-bridge.ts`, `implementation-view.ts`).
 */
function startDesktopBridge(context: ExtensionContext): void {
    const url = process.env.APPLING_DESKTOP_BRIDGE;
    const token = process.env.APPLING_DESKTOP_TOKEN;
    if (!url || !token) return;
    commands.executeCommand('setContext', 'appling.desktop', true);
    const view = new ImplementationView(qn => bridge.showElement(qn));
    context.subscriptions.push(view);
    const bridge = connectDesktop({
        url, token,
        log: message => console.error(message),
        editor: {
            onCursor: listener => window.onDidChangeTextEditorSelection(event => {
                const document = event.textEditor.document;
                if (document.languageId === 'appling') listener(document.uri.toString(), document.offsetAt(event.selections[0].active));
            }),
            reveal: async (uri, start, end) => {
                const document = await workspace.openTextDocument(Uri.parse(uri));
                const editor = await window.showTextDocument(document, { preview: true });
                const from = document.positionAt(start);
                editor.selection = new Selection(from, from);
                editor.revealRange(new Range(from, document.positionAt(end)), TextEditorRevealType.InCenterIfOutsideViewport);
            },
            diff: async (path, before, rev, line) => {
                // the built in git extension serves `git:` URIs: the file's text at a revision
                const old = Uri.file(before).with({ scheme: 'git', query: JSON.stringify({ path: before, ref: rev }) });
                const now = Uri.file(path);
                const exists = await workspace.fs.stat(now).then(() => true, () => false);
                const at = line ? new Range(line - 1, 0, line - 1, 0) : undefined;
                if (!exists) {
                    await window.showTextDocument(old, { preview: true, selection: at });
                    return;
                }
                await commands.executeCommand('vscode.diff', old, now, `${basename(path)} (${rev.slice(0, 12)} ↔ Working Tree)`, { preview: true, selection: at });
            },
            implementation: state => view.update(state),
            open: (path, start, end) => view.open(path, start, end)
        }
    });
    context.subscriptions.push(bridge);
}

export async function deactivate(): Promise<void> {
    await client?.stop();
}

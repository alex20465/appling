import { join } from 'node:path';
import { commands, Uri, window, type ExtensionContext } from 'vscode';
import { LanguageClient, TransportKind, type LanguageClientOptions, type ServerOptions } from 'vscode-languageclient/node';
import { AgentsView } from './agents-view.js';
import { connectDesktop } from './desktop-bridge.js';
import { openDiff, revealOffsets } from './editor.js';
import { ImplementationView } from './implementation-view.js';
import { Workbench } from './workbench.js';

let client: LanguageClient | undefined;

/**
 * Starts the bundled Appling language server for every `.appling` file in the workspace. Inside Appling Desktop's code
 * view the bridge to Desktop's canvas starts too; in any other window the Appling workbench with its IDE tabs and
 * agent sessions.
 */
export async function activate(context: ExtensionContext): Promise<void> {
    const bridged = startDesktopBridge(context);
    const module = context.asAbsolutePath(join('out', 'server.js'));
    const server: ServerOptions = {
        run: { module, transport: TransportKind.ipc },
        debug: { module, transport: TransportKind.ipc, options: { execArgv: ['--nolazy', '--inspect=6009'] } }
    };
    const options: LanguageClientOptions = { documentSelector: [{ scheme: 'file', language: 'appling' }] };
    client = new LanguageClient('appling', 'Appling', server, options);
    await client.start();
    if (!bridged) await startWorkbench(context);
}

/**
 * Inside Appling Desktop's code view: syncs the selection with the canvas, marks how far each model line is implemented
 * and links code and elements both ways (see `desktop-bridge.ts`, `implementation-view.ts`).
 */
function startDesktopBridge(context: ExtensionContext): boolean {
    const url = process.env.APPLING_DESKTOP_BRIDGE;
    const token = process.env.APPLING_DESKTOP_TOKEN;
    if (!url || !token) return false;
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
            reveal: (uri, start, end) => revealOffsets(Uri.parse(uri), start, end),
            diff: (path, before, rev, line) => openDiff(path, before, rev, line),
            implementation: state => view.update(state),
            open: (path, start, end) => view.open(path, start, end)
        }
    });
    context.subscriptions.push(bridge);
    return true;
}

/** Appling in a plain VS Code window: the Projects and Agent Sessions views, the IDE tabs, `Initialize Appling`. */
async function startWorkbench(context: ExtensionContext): Promise<void> {
    const workbench = new Workbench(context);
    const agents = new AgentsView(context, workbench);
    context.subscriptions.push(workbench, agents);
    await agents.start();
    await workbench.refresh();
}

export async function deactivate(): Promise<void> {
    await client?.stop();
}

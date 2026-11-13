import { join } from 'node:path';
import type { ExtensionContext } from 'vscode';
import { LanguageClient, TransportKind, type LanguageClientOptions, type ServerOptions } from 'vscode-languageclient/node';
import { AgentsView } from './agents-view.js';
import { Workbench } from './workbench.js';

let client: LanguageClient | undefined;

/** Starts the bundled Appling language server for every `.appling` file in the workspace and the Appling workbench. */
export async function activate(context: ExtensionContext): Promise<void> {
    const module = context.asAbsolutePath(join('out', 'server.js'));
    const server: ServerOptions = {
        run: { module, transport: TransportKind.ipc },
        debug: { module, transport: TransportKind.ipc, options: { execArgv: ['--nolazy', '--inspect=6009'] } }
    };
    const options: LanguageClientOptions = { documentSelector: [{ scheme: 'file', language: 'appling' }] };
    client = new LanguageClient('appling', 'Appling', server, options);
    await client.start();
    await startWorkbench(context);
}

/** The Projects and Agent Sessions views, the inspector tabs, `Initialize Appling`. */
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

import { join } from 'node:path';
import type { ExtensionContext } from 'vscode';
import { LanguageClient, TransportKind, type LanguageClientOptions, type ServerOptions } from 'vscode-languageclient/node';

let client: LanguageClient | undefined;

/** Starts the bundled Appling language server for every `.appling` file in the workspace. */
export async function activate(context: ExtensionContext): Promise<void> {
    const module = context.asAbsolutePath(join('out', 'server.js'));
    const server: ServerOptions = {
        run: { module, transport: TransportKind.ipc },
        debug: { module, transport: TransportKind.ipc, options: { execArgv: ['--nolazy', '--inspect=6009'] } }
    };
    const options: LanguageClientOptions = { documentSelector: [{ scheme: 'file', language: 'appling' }] };
    client = new LanguageClient('appling', 'Appling', server, options);
    await client.start();
}

export async function deactivate(): Promise<void> {
    await client?.stop();
}

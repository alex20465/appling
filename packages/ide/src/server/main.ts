#!/usr/bin/env node
import { resolve } from 'node:path';
import { ipcChannel, remoteAppHost, RemoteSessionStore } from '@appling/ai';
import { startIde, type Implementation } from './server.js';
import { snapshot } from './workspace.js';

const args = process.argv.slice(2);
const portIndex = args.indexOf('--port');
const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 4410;
const valued = new Set(['--port', '--origin']);
const root = resolve(args.find((a, i) => !a.startsWith('--') && !valued.has(args[i - 1])) ?? '.');
// --origin <url> (repeatable): an origin to trust too, the local end of a port that Appling Desktop forwards here.
const origins = args.flatMap((a, i) => a === '--origin' && args[i + 1] ? [args[i + 1]] : []);

// Started by an app with an IPC channel (Appling Desktop, the VS Code extension): it shows the number of model errors,
// the unsaved files and the unseen model changes.
const status = (errors: string[]) => process.send?.({ type: 'status', errors: errors.length });
// With --shared-sessions, the app holds the agent sessions of the workspace and serves them over IPC.
const shared = process.send && args.includes('--shared-sessions')
    ? { sessions: new RemoteSessionStore(ipcChannel(process)), host: remoteAppHost(ipcChannel(process)) } : {};
const unsaved = (files: string[]) => process.send?.({ type: 'status', unsaved: files });
const unseen = (changes: number) => process.send?.({ type: 'status', changes });
// the implementation marks and code links for the code view
const implementation = (state: Implementation) => process.send?.({ type: 'implementation', ...state });
const ide = await startIde(root, port, { origins, ...process.send ? { onSnapshot: s => status(s.errors), onUnsaved: unsaved, onUnseen: unseen, onImplementation: implementation, ...shared } : {} });
console.log(`Appling IDE for ${root} at ${ide.url}`);

// Started with an IPC channel (Appling Desktop, the VS Code extension): report the URL and end with the app.
if (process.send) {
    process.send({ type: 'ready', url: ide.url });
    // the VS Code extension reaches the server at a forwarded port in remote windows and names that origin
    process.on('message', (message: { type?: string, origin?: unknown }) => {
        if (message?.type === 'trust' && typeof message.origin === 'string') ide.trust(message.origin);
    });
    snapshot(root).then(s => status(s.errors), () => undefined);
    process.once('disconnect', () => ide.close().finally(() => process.exit(0)));
}

#!/usr/bin/env node
import { resolve } from 'node:path';
import { ipcChannel, remoteAppHost, RemoteSessionStore } from '@appling/ai';
import { startIde } from './server.js';
import { snapshot } from './workspace.js';

const args = process.argv.slice(2);
const portIndex = args.indexOf('--port');
const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 4410;
const root = resolve(args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--port') ?? '.');

// Started by Appling Desktop with an IPC channel: it shows the number of model errors and the unsaved files on the rail.
const status = (errors: string[]) => process.send?.({ type: 'status', errors: errors.length });
// With --shared-sessions, Appling Desktop holds the agent sessions of the workspace and serves them over IPC.
const shared = process.send && args.includes('--shared-sessions') ? { sessions: new RemoteSessionStore(ipcChannel(process)), host: remoteAppHost(ipcChannel(process)) } : {};
const unsaved = (files: string[]) => process.send?.({ type: 'status', unsaved: files });
const ide = await startIde(root, port, process.send ? { onSnapshot: s => status(s.errors), onUnsaved: unsaved, ...shared } : {});
console.log(`Appling IDE for ${root} at ${ide.url}`);

// Started by Appling Desktop with an IPC channel: report the URL and end with the app.
if (process.send) {
    process.send({ type: 'ready', url: ide.url });
    snapshot(root).then(s => status(s.errors), () => undefined);
    process.once('disconnect', () => ide.close().finally(() => process.exit(0)));
}

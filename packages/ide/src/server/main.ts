#!/usr/bin/env node
import { resolve } from 'node:path';
import { ipcChannel, remoteAppHost, RemotePlaybookStore, RemoteSessionStore } from '@appling/ai';
import { startIde, type Implementation } from './server.js';
import { snapshot } from './workspace.js';

const args = process.argv.slice(2);
const portIndex = args.indexOf('--port');
const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 4410;
const valued = new Set(['--port', '--origin']);
const root = resolve(args.find((a, i) => !a.startsWith('--') && !valued.has(args[i - 1])) ?? '.');
// --origin <url> (repeatable): an origin to trust too, the local end of a port that Appling Desktop forwards here.
const origins = args.flatMap((a, i) => a === '--origin' && args[i + 1] ? [args[i + 1]] : []);

// Started by Appling Desktop with an IPC channel: it shows the number of model errors, the unsaved files and the
// unseen model changes on the rail.
const status = (errors: string[]) => process.send?.({ type: 'status', errors: errors.length });
// With --shared-sessions, Appling Desktop holds the agent sessions and the playbooks of the workspace and serves them over IPC.
const shared = process.send && args.includes('--shared-sessions')
    ? { sessions: new RemoteSessionStore(ipcChannel(process)), playbooks: new RemotePlaybookStore(ipcChannel(process)), host: remoteAppHost(ipcChannel(process)) } : {};
const unsaved = (files: string[]) => process.send?.({ type: 'status', unsaved: files });
const unseen = (changes: number) => process.send?.({ type: 'status', changes });
// the implementation marks and code links for the code view
const implementation = (state: Implementation) => process.send?.({ type: 'implementation', ...state });
const ide = await startIde(root, port, { origins, ...process.send ? { onSnapshot: s => status(s.errors), onUnsaved: unsaved, onUnseen: unseen, onImplementation: implementation, ...shared } : {} });
console.log(`Appling IDE for ${root} at ${ide.url}`);

// Started by Appling Desktop with an IPC channel: report the URL and end with the app.
if (process.send) {
    process.send({ type: 'ready', url: ide.url });
    snapshot(root).then(s => status(s.errors), () => undefined);
    process.once('disconnect', () => ide.close().finally(() => process.exit(0)));
}

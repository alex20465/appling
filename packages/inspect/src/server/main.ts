#!/usr/bin/env node
import { resolve } from 'node:path';
import { ipcChannel, remoteAppHost, RemoteSessionStore } from '@appling/ai';
import { startInspect, type Implementation } from './server.js';
import { snapshot } from './workspace.js';

const args = process.argv.slice(2);
const portIndex = args.indexOf('--port');
const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 4410;
const root = resolve(args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--port') ?? '.');

// Started by an app with an IPC channel (the VS Code extension): it shows the number of model errors.
const status = (errors: string[]) => process.send?.({ type: 'status', errors: errors.length });
// With --shared-sessions, the app holds the agent sessions of the workspace and serves them over IPC.
const shared = process.send && args.includes('--shared-sessions')
    ? { sessions: new RemoteSessionStore(ipcChannel(process)), host: remoteAppHost(ipcChannel(process)) } : {};
// the implementation marks and code links for the code view
const implementation = (state: Implementation) => process.send?.({ type: 'implementation', ...state });
const inspect = await startInspect(root, port, process.send ? { onSnapshot: s => status(s.errors), onImplementation: implementation, ...shared } : {});
console.log(`Appling Inspect for ${root} at ${inspect.url}`);

// Started with an IPC channel (the VS Code extension): report the URL and end with the app.
if (process.send) {
    process.send({ type: 'ready', url: inspect.url });
    // the VS Code extension reaches the server at a forwarded port in remote windows and names that origin
    process.on('message', (message: { type?: string, origin?: unknown }) => {
        if (message?.type === 'trust' && typeof message.origin === 'string') inspect.trust(message.origin);
    });
    snapshot(root).then(s => status(s.errors), () => undefined);
    process.once('disconnect', () => inspect.close().finally(() => process.exit(0)));
}

#!/usr/bin/env node
import { resolve } from 'node:path';
import { startIde } from './server.js';
import { snapshot } from './workspace.js';

const args = process.argv.slice(2);
const portIndex = args.indexOf('--port');
const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 4410;
const root = resolve(args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--port') ?? '.');

// Started by Appling Desktop with an IPC channel: it shows the number of model errors on the rail.
const status = (errors: string[]) => process.send?.({ type: 'status', errors: errors.length });
const ide = await startIde(root, port, process.send ? { onSnapshot: s => status(s.errors) } : {});
console.log(`Appling IDE for ${root} at ${ide.url}`);

// Started by Appling Desktop with an IPC channel: report the URL and end with the app.
if (process.send) {
    process.send({ type: 'ready', url: ide.url });
    snapshot(root).then(s => status(s.errors), () => undefined);
    process.once('disconnect', () => ide.close().finally(() => process.exit(0)));
}

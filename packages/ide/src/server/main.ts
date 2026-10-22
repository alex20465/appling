#!/usr/bin/env node
import { resolve } from 'node:path';
import { startIde } from './server.js';

const args = process.argv.slice(2);
const portIndex = args.indexOf('--port');
const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 4410;
const root = resolve(args.find((a, i) => !a.startsWith('--') && i !== portIndex + 1) ?? '.');

const ide = await startIde(root, port);
console.log(`Appling IDE for ${root} at ${ide.url}`);

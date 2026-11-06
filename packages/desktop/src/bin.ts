#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `appling-desktop [folders or .code-workspace files...]`: opens the workspace files and adds the folders (default:
 * the current one) to the active workspace of the running app, or starts it. Electron's single instance lock hands
 * the paths of a second start to the first one, which then quits the second.
 */
const paths = (process.argv.length > 2 ? process.argv.slice(2) : ['.']).map(path => resolve(path));
const missing = paths.filter(path => !existsSync(path) || (path.endsWith('.code-workspace') ? !statSync(path).isFile() : !statSync(path).isDirectory()));
if (missing.length) {
    console.error(`Not a folder or a .code-workspace file: ${missing.join(', ')}`);
    process.exit(2);
}

const require = createRequire(import.meta.url);
// Electron downloads its binary on first use; do it in the foreground so the progress shows.
spawnSync(process.execPath, ['-e', 'require(process.argv[1])', require.resolve('electron')], { stdio: 'inherit' });
const binary = require('electron') as string;
const main = fileURLToPath(new URL('./main.js', import.meta.url));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
spawn(binary, [main, '--', ...paths], { stdio: 'ignore', detached: true, env }).unref();

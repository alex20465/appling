#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `appling-desktop [folders...]`: opens the folders (default: the current one) in the running app, or starts it.
 * Electron's single instance lock hands the folders of a second start to the first one, which then quits the second.
 */
const folders = (process.argv.length > 2 ? process.argv.slice(2) : ['.']).map(folder => resolve(folder));
const missing = folders.filter(folder => !existsSync(folder) || !statSync(folder).isDirectory());
if (missing.length) {
    console.error(`Not a folder: ${missing.join(', ')}`);
    process.exit(2);
}

const require = createRequire(import.meta.url);
// Electron downloads its binary on first use; do it in the foreground so the progress shows.
spawnSync(process.execPath, ['-e', 'require(process.argv[1])', require.resolve('electron')], { stdio: 'inherit' });
const binary = require('electron') as string;
const main = fileURLToPath(new URL('./main.js', import.meta.url));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
spawn(binary, [main, '--', ...folders], { stdio: 'ignore', detached: true, env }).unref();

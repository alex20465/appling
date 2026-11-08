#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRemoteId, locationId, parseLocation } from './remote/location.js';

import { sessionArg, trayMode, withoutAppFlags } from './app-flags.js';

/**
 * `appling-desktop [--session <terminal>] [--tray] [folders, remote repos or .code-workspace files...]`: opens the workspace files and adds the folders
 * (default: the current one) and remote repos (`ssh://host/path`, `wsl://distro/path`, `devcontainer:///folder`, see
 * `remote/location.ts`) to the active workspace of the running app, or starts it. Electron's single instance lock hands
 * the paths of a second start to the first one, which then quits the second.
 * `--session` opens the app at a terminal of the pty host, `--tray` starts the tray only mode.
 */
/** A remote repo's canonical id, undefined when it does not parse. */
const remote = (path: string) => {
    try {
        return locationId(parseLocation(path));
    } catch {
        return undefined;
    }
};
const argv = process.argv.slice(2);
const tray = trayMode(argv);
const session = sessionArg(argv);
const given = withoutAppFlags(argv).filter(arg => arg !== '--');
const args = given.length || tray || session ? given : ['.'];
const missing = args.filter(path => isRemoteId(path)
    ? !remote(path)
    : !existsSync(path) || (path.endsWith('.code-workspace') ? !statSync(path).isFile() : !statSync(path).isDirectory()));
const paths = args.map(path => isRemoteId(path) ? remote(path)! : resolve(path));
if (missing.length) {
    console.error(`Not a folder, a remote repo or a .code-workspace file: ${missing.join(', ')}`);
    process.exit(2);
}

const require = createRequire(import.meta.url);
// Electron downloads its binary on first use; do it in the foreground so the progress shows.
spawnSync(process.execPath, ['-e', 'require(process.argv[1])', require.resolve('electron')], { stdio: 'inherit' });
const binary = require('electron') as string;
const main = fileURLToPath(new URL('./main.js', import.meta.url));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
spawn(binary, [main, ...tray ? ['--tray'] : [], ...session ? ['--session', session] : [], '--', ...paths], { stdio: 'ignore', detached: true, env }).unref();

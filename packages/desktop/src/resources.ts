import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The Node programs Desktop runs as child processes (with `ELECTRON_RUN_AS_NODE`) or hands to other tools. */
export type Program = 'ide' | 'pty-host' | 'language-server' | 'mcp';

/**
 * Where `scripts/bundle.mjs` puts each program in the packaged app, relative to the bundled `main.js`. Every bundle keeps
 * its package's layout, so the files a package finds next to its own code (the IDE client, the AI skills) are there.
 */
export const BUNDLED: Record<Program, string> = {
    ide: 'ide/out/server/main.js',
    'pty-host': 'pty-host/out/main.js',
    'language-server': 'lang/out/language-server.js',
    mcp: 'ai/out/main.js'
};

/** The same programs in the workspace (or an npm install): a file the package lets resolve, and the entry relative to its folder. */
const INSTALLED: Record<Program, [string, string]> = {
    ide: ['@appling/ide/package.json', 'out/server/main.js'],
    'pty-host': ['@appling/pty-host', 'main.js'],
    'language-server': ['@appling/lang', 'language-server.js'],
    mcp: ['@appling/ai', 'main.js']
};

/**
 * The entry file of a program: the bundled one when Desktop runs packaged (it lies next to the bundled main), else the
 * built one of its workspace package. `base` is the folder of Desktop's main file.
 */
export function programPath(program: Program, base: string = dirname(fileURLToPath(import.meta.url))): string {
    const bundled = join(base, BUNDLED[program]);
    if (existsSync(bundled)) return bundled;
    const [pkg, entry] = INSTALLED[program];
    return join(dirname(createRequire(import.meta.url).resolve(pkg)), entry);
}

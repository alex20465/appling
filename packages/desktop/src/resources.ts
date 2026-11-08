import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What Desktop finds at run time: the Node programs it runs as child processes (with `ELECTRON_RUN_AS_NODE`) or hands
 * to other tools, and the Appling extension (`vsix`) it installs into the code view.
 */
export type Program = 'ide' | 'pty-host' | 'language-server' | 'mcp' | 'cli' | 'vsix';

/**
 * Where `scripts/bundle.mjs` puts each program in the packaged app, relative to the app's root (Desktop's main is
 * `out/main.js` there). Every bundle keeps its package's layout, so the files a package finds next to its own code (the
 * IDE client, the AI skills) are there.
 */
export const BUNDLED: Record<Program, string> = {
    ide: 'ide/out/server/main.js',
    'pty-host': 'pty-host/out/main.js',
    'language-server': 'lang/out/language-server.js',
    mcp: 'ai/out/main.js',
    cli: 'cli/out/main.js',
    vsix: 'vscode/appling.vsix'
};

/**
 * Files that programs outside Electron read (openvscode-server installs the vsix), so the packaged app keeps them
 * outside its asar archive (`asarUnpack` in electron-builder.config.mjs) and hands out their unpacked path.
 */
export const UNPACKED: readonly Program[] = ['vsix'];

/** The same programs in the workspace (or an npm install): a file the package lets resolve, and the entry relative to its folder. */
const INSTALLED: Record<Program, [string, string]> = {
    ide: ['@appling/ide/package.json', 'out/server/main.js'],
    'pty-host': ['@appling/pty-host', 'main.js'],
    'language-server': ['@appling/lang', 'language-server.js'],
    mcp: ['@appling/ai', 'main.js'],
    cli: ['@appling/cli/package.json', 'out/main.js'],
    vsix: ['appling-vscode/package.json', 'out/appling.vsix']
};

/**
 * The entry file of a program: the bundled one when Desktop runs packaged, else the built one of its workspace package.
 * `base` is the folder above Desktop's main file: the app's root when packaged, `packages/desktop` in the workspace.
 * Throws when neither is there to resolve.
 */
export function programPath(program: Program, base: string = dirname(dirname(fileURLToPath(import.meta.url)))): string {
    const bundled = join(base, BUNDLED[program]);
    if (existsSync(bundled)) return UNPACKED.includes(program) ? bundled.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`) : bundled;
    const [pkg, entry] = INSTALLED[program];
    return join(dirname(createRequire(import.meta.url).resolve(pkg)), entry);
}

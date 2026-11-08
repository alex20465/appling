// Writes the packaged app's contents to `app/`, which electron-builder packs: Desktop's main process and every
// program it runs (the IDE server, the pty host, the language server, the MCP server), each bundled by esbuild into one
// file at the place `src/resources.ts` (BUNDLED) looks, next to the files its package reads at runtime. node-pty is
// native, so it is copied (not bundled) to `native/node-pty`; it is N-API, so the Node build runs in Electron as is.
// Run after `pnpm build` of the workspace (`pnpm --filter @appling/desktop package` does both steps of packaging:
// this bundle, then electron-builder). APPLING_DESKTOP_VERSION sets the app's version (the release workflow
// passes the tag's), else this package's version is used.
import { build } from 'esbuild';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packages = dirname(root);
// `--out <folder>` writes elsewhere (the tests do); electron-builder packs `app/`.
const out = process.argv.indexOf('--out');
const app = out >= 0 ? process.argv[out + 1] : join(root, 'app');
const desktop = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

rmSync(app, { recursive: true, force: true });
mkdirSync(app, { recursive: true });

// ESM bundles of CommonJS dependencies still call require and read __dirname.
const banner = [
    "import { createRequire as __appling_createRequire } from 'node:module';",
    "import { fileURLToPath as __appling_fileURLToPath } from 'node:url';",
    "import { dirname as __appling_dirname } from 'node:path';",
    'const require = __appling_createRequire(import.meta.url);',
    'const __filename = __appling_fileURLToPath(import.meta.url);',
    'const __dirname = __appling_dirname(__filename);'
].join('\n');

/** node-pty stays a runtime import of the copy in `native/`, relative to the bundle. */
const nodePty = (from) => ({
    name: 'node-pty',
    setup(build) {
        build.onResolve({ filter: /^node-pty$/ }, () => ({ path: from, external: true }));
    }
});

async function bundle(entry, out, plugins = []) {
    await build({
        entryPoints: [entry], outfile: join(app, out), bundle: true, platform: 'node', format: 'esm', target: 'node24',
        external: ['electron'], banner: { js: banner }, plugins, logLevel: 'warning', legalComments: 'none',
        // the IDE server and the MCP server import the floating window host of @appling/viz, which resolves its
        // optional editor launcher only when used
        logOverride: { 'require-resolve-not-external': 'silent' }
    });
}

// Desktop: main process, preload and the shell page.
await bundle(join(root, 'out/main.js'), 'main.js');
cpSync(join(root, 'out/preload.cjs'), join(app, 'preload.cjs'));
cpSync(join(root, 'out/shell'), join(app, 'shell'), { recursive: true });

// The programs, at the paths of BUNDLED in src/resources.ts, each with the files its package reads next to its code.
const aiFiles = (to) => ['skills', 'language'].forEach(dir => cpSync(join(packages, 'ai', dir), join(app, to, dir), { recursive: true }));
await bundle(join(packages, 'ide/out/server/main.js'), 'ide/out/server/main.js');
cpSync(join(packages, 'ide/dist/client'), join(app, 'ide/dist/client'), { recursive: true });
aiFiles('ide/out');
await bundle(join(packages, 'ai/out/main.js'), 'ai/out/main.js');
aiFiles('ai');
await bundle(join(packages, 'lang/out/language-server.js'), 'lang/out/language-server.js');
await bundle(join(packages, 'pty-host/out/main.js'), 'pty-host/out/main.js', [nodePty('../../native/node-pty/lib/index.js')]);
const ptyHost = JSON.parse(readFileSync(join(packages, 'pty-host/package.json'), 'utf8'));
writeFileSync(join(app, 'pty-host/package.json'), JSON.stringify({ name: ptyHost.name, version: ptyHost.version, type: 'module' }, null, 2));

// node-pty: its JavaScript, its license and the native files of this platform (a local build, else the prebuilds).
const pty = dirname(realpathSync(createRequire(join(packages, 'pty-host/package.json')).resolve('node-pty/package.json')));
const native = join(app, 'native/node-pty');
const binary = (file) => !file.endsWith('.pdb');
const runtime = (file) => !/\.(test\.js|map)$/.test(file);
for (const part of ['package.json', 'LICENSE', 'lib']) cpSync(join(pty, part), join(native, part), { recursive: true, filter: runtime });
if (existsSync(join(pty, 'build/Release'))) {
    cpSync(join(pty, 'build/Release'), join(native, 'build/Release'), { recursive: true, filter: source => binary(source) && !/[\\/](obj\.target|\.deps)([\\/]|$)/.test(source) });
}
for (const dir of existsSync(join(pty, 'prebuilds')) ? readdirSync(join(pty, 'prebuilds')) : []) {
    if (dir.startsWith(`${process.platform}-`)) cpSync(join(pty, 'prebuilds', dir), join(native, 'prebuilds', dir), { recursive: true, filter: binary });
}
// the macOS helper that forks the shell must be executable; the npm tarball does not always keep the mode
for (const dir of ['build/Release', ...(existsSync(join(native, 'prebuilds')) ? readdirSync(join(native, 'prebuilds')).map(d => `prebuilds/${d}`) : [])]) {
    const helper = join(native, dir, 'spawn-helper');
    if (existsSync(helper)) chmodSync(helper, 0o755);
}

// The app's own package.json: no dependencies, so electron-builder packs `app/` as it is.
writeFileSync(join(app, 'package.json'), JSON.stringify({
    name: 'appling-desktop',
    productName: 'Appling',
    version: process.env.APPLING_DESKTOP_VERSION || desktop.version,
    description: desktop.description,
    homepage: desktop.homepage,
    author: 'Alexandros Fotiadis',
    license: desktop.license,
    type: 'module',
    main: 'main.js'
}, null, 2));

console.log(`Bundled Appling Desktop ${process.env.APPLING_DESKTOP_VERSION || desktop.version} into ${app}`);

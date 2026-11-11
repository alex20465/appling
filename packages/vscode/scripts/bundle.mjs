// Writes the extension's files to `out/`, which `vsce package` packs (see .vscodeignore): the extension and the language
// server (CommonJS, as VS Code loads extensions), the IDE server each project runs with its generation worker, client
// and the AI package's skills and language pages (ESM under `out/ide/`, at the paths `@appling/ide` reads them from),
// the `appling` command line, the command hook of agent sessions and the Appling icon. Run after `pnpm build` of the
// upstream packages.
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packages = dirname(root);
const out = join(root, 'out');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// The extension bundles ESM packages that read files next to their code through `import.meta.url`: `@appling/ai` reads
// its skills and language pages from `../skills/` and `../language/` of the bundle at load time, so the bundle sits in
// `out/extension/` and they in `out/`.
await build({
    entryPoints: [join(root, 'src/extension.ts')], outfile: join(out, 'extension/extension.js'), bundle: true, platform: 'node', format: 'cjs', target: 'node20',
    external: ['vscode'], define: { 'import.meta.url': '__appling_import_meta_url' },
    banner: { js: "const __appling_import_meta_url = require('node:url').pathToFileURL(__filename).href;" }, logLevel: 'warning', legalComments: 'none'
});
await build({
    entryPoints: [join(packages, 'lang/out/language-server.js')], outfile: join(out, 'server.js'), bundle: true, platform: 'node', format: 'cjs', target: 'node20',
    logLevel: 'warning', legalComments: 'none'
});
cpSync(join(packages, 'lang/src/syntaxes/appling.tmLanguage.json'), join(out, 'appling.tmLanguage.json'));
for (const dir of ['skills', 'language']) cpSync(join(packages, 'ai', dir), join(out, dir), { recursive: true });
cpSync(join(packages, 'ai/out/agents/hook.cjs'), join(out, 'hook.cjs'));
cpSync(join(packages, 'ide/public/appling-icon.svg'), join(out, 'appling-icon.svg'));

// ESM bundles of CommonJS dependencies still call require and read __dirname. The banner keeps its own names and
// `define` points the free __filename and __dirname at them, so an ESM dependency declaring its own (`open`) does not clash.
const banner = [
    "import { createRequire as __appling_createRequire } from 'node:module';",
    "import { fileURLToPath as __appling_fileURLToPath } from 'node:url';",
    "import { dirname as __appling_dirname } from 'node:path';",
    'const require = __appling_createRequire(import.meta.url);',
    'const __appling_file = __appling_fileURLToPath(import.meta.url);',
    'const __appling_dir = __appling_dirname(__appling_file);'
].join('\n');
const define = { __filename: '__appling_file', __dirname: '__appling_dir' };
const ide = join(out, 'ide');
for (const file of ['main.js', 'generation-worker.js']) {
    await build({
        entryPoints: [join(packages, 'ide/out/server', file)], outfile: join(ide, 'out/server', file), bundle: true, platform: 'node', format: 'esm', target: 'node20',
        banner: { js: banner }, define, logLevel: 'warning', legalComments: 'none'
    });
}
cpSync(join(packages, 'ide/dist/client'), join(ide, 'dist/client'), { recursive: true });
for (const dir of ['skills', 'language']) cpSync(join(packages, 'ai', dir), join(ide, 'out', dir), { recursive: true });
writeFileSync(join(ide, 'package.json'), `${JSON.stringify({ type: 'module' })}\n`);
// the `appling` command line that Initialize Appling runs (`appling init`)
await build({
    entryPoints: [join(packages, 'cli/out/main.js')], outfile: join(out, 'cli/main.js'), bundle: true, platform: 'node', format: 'esm', target: 'node20',
    banner: { js: banner }, define, logLevel: 'warning', legalComments: 'none'
});
writeFileSync(join(out, 'cli/package.json'), `${JSON.stringify({ type: 'module' })}\n`);

// Writes the extension's files to `out/`, which `vsce package` packs (see .vscodeignore): the extension and the language
// server (CommonJS, as VS Code loads extensions), the inspect server each project runs with its client and the AI
// package's skills and language pages (ESM under `out/inspect/`, at the paths `@appling/inspect` reads them from),
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
cpSync(join(packages, 'inspect/public/appling-icon.svg'), join(out, 'appling-icon.svg'));

// ESM bundles of CommonJS dependencies still call require and read __dirname.
const banner = [
    "import { createRequire as __appling_createRequire } from 'node:module';",
    "import { fileURLToPath as __appling_fileURLToPath } from 'node:url';",
    "import { dirname as __appling_dirname } from 'node:path';",
    // var: a bundled package may declare these itself (`open` has its own __dirname)
    'var require = __appling_createRequire(import.meta.url);',
    'var __filename = __appling_fileURLToPath(import.meta.url);',
    'var __dirname = __appling_dirname(__filename);'
].join('\n');
const inspect = join(out, 'inspect');
await build({
    entryPoints: [join(packages, 'inspect/out/server/main.js')], outfile: join(inspect, 'out/server/main.js'), bundle: true, platform: 'node', format: 'esm', target: 'node20',
    banner: { js: banner }, logLevel: 'warning', legalComments: 'none'
});
cpSync(join(packages, 'inspect/dist/client'), join(inspect, 'dist/client'), { recursive: true });
for (const dir of ['skills', 'language']) cpSync(join(packages, 'ai', dir), join(inspect, 'out', dir), { recursive: true });
writeFileSync(join(inspect, 'package.json'), `${JSON.stringify({ type: 'module' })}\n`);
// the `appling` command line that Initialize Appling runs (`appling init`)
await build({
    entryPoints: [join(packages, 'cli/out/main.js')], outfile: join(out, 'cli/main.js'), bundle: true, platform: 'node', format: 'esm', target: 'node20',
    banner: { js: banner }, logLevel: 'warning', legalComments: 'none'
});
writeFileSync(join(out, 'cli/package.json'), `${JSON.stringify({ type: 'module' })}\n`);

// Builds the terminal panel page after tsc: bundles the view with xterm.js and its addons, and copies the page,
// its styles and the shell integration scripts next to the compiled modules.
import { cpSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
mkdirSync('out/terminal/view', { recursive: true });
await build({
    entryPoints: ['src/terminal/view/view.ts'],
    outfile: 'out/terminal/view/view.js',
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome140',
    minify: true,
    sourcemap: true,
    logLevel: 'warning'
});
cpSync('src/terminal/view/index.html', 'out/terminal/view/index.html');
cpSync('src/terminal/view/view.css', 'out/terminal/view/view.css');
cpSync(require.resolve('@xterm/xterm/css/xterm.css'), 'out/terminal/view/xterm.css');
cpSync('src/terminal/scripts', 'out/terminal/scripts', { recursive: true });

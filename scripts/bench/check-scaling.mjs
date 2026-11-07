// Times `appling check` on N copies of the examples/ modules, to catch build time that grows faster than the model.
// Usage: node scripts/bench/check-scaling.mjs [copies...]   (default 1 10 50 200; build the CLI first)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('../../', import.meta.url).pathname;
const cli = join(root, 'packages/cli/out/main.js');
const sources = readdirSync(join(root, 'examples'))
    .filter(f => /^[^.].*\.appling$/.test(f))
    .map(f => ({ name: f.replace(/\.appling$/, ''), text: readFileSync(join(root, 'examples', f), 'utf8') }));
const modules = sources.map(s => s.name);

for (const copies of (process.argv.length > 2 ? process.argv.slice(2) : ['1', '10', '50', '200']).map(Number)) {
    const dir = mkdtempSync(join(tmpdir(), 'appling-bench-'));
    let lines = 0;
    for (let i = 0; i < copies; i++) {
        for (const { name, text } of sources) {
            // Renames every module name of the examples to its numbered copy, so the copies reference each other pairwise.
            const copy = modules.reduce((t, m) => t.replace(new RegExp(`\\b${m}\\b`, 'g'), `${m}${i}`), text);
            lines += copy.split('\n').length;
            writeFileSync(join(dir, `${name}${i}.appling`), copy);
        }
    }
    const start = performance.now();
    try { execFileSync(process.execPath, [cli, 'check', dir], { stdio: 'ignore' }); } catch { /* errors are expected to be reported, not timed */ }
    console.log(`${copies} copies, ${copies * sources.length} files, ${lines} lines: ${Math.round(performance.now() - start)} ms`);
    rmSync(dir, { recursive: true, force: true });
}

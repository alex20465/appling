// Links a workspace package to the user: each command of its `bin` becomes a launcher in ~/.local/bin (or BIN_DIR) that runs
// the built file in this repo, so every rebuild takes effect at once. A package with a `host:link` script (the VS Code
// extension) runs that instead. `--remove` takes the link out again.
// Usage: node scripts/link.mjs [--remove] <package folder under packages/>
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const remove = args.includes('--remove');
const folder = args.find((arg) => arg !== '--remove');
const dir = join(root, 'packages', folder ?? '');
if (!folder || !existsSync(join(dir, 'package.json'))) {
    console.error('Usage: node scripts/link.mjs [--remove] <package folder under packages/>');
    process.exit(2);
}
const { name, bin, scripts = {} } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));

if (scripts['host:link']) {
    const run = spawnSync('corepack', ['pnpm', '--dir', dir, 'run', remove ? 'host:unlink' : 'host:link'], { stdio: 'inherit' });
    process.exit(run.status ?? 1);
}
if (!bin) {
    console.error(`${name} has no commands to link.`);
    process.exit(1);
}

const binDir = process.env.BIN_DIR || join(homedir(), '.local', 'bin');
const marker = `# appling link: ${name}`;
const commands = typeof bin === 'string' ? { [name.split('/').pop()]: bin } : bin;
mkdirSync(binDir, { recursive: true });
for (const [command, file] of Object.entries(commands)) {
    const launcher = join(binDir, command);
    const ours = existsSync(launcher) && readFileSync(launcher, 'utf8').includes(marker);
    if (existsSync(launcher) && !ours) {
        console.error(`Skipped ${launcher}: it exists and was not linked from here.`);
        continue;
    }
    if (remove) {
        if (ours) rmSync(launcher);
        console.log(`Removed ${launcher}`);
        continue;
    }
    const target = resolve(dir, file);
    writeFileSync(launcher, `#!/bin/sh\n${marker}\nexec node "${target}" "$@"\n`, { mode: 0o755 });
    console.log(`Linked ${launcher} -> ${target}${existsSync(target) ? '' : ` (not built yet: pnpm --filter "${name}..." build)`}`);
}

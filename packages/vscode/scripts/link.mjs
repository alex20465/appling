// Links this package into the host's editors for end to end testing: every rebuild (`pnpm --filter "appling-vscode..." build`)
// then runs in the real VS Code or VSCodium after Developer: Reload Window. Replaces an installed copy of the extension
// with a symlink to this folder and registers it in the editor's extensions.json. `--remove` takes the link out again.
// Usage: node scripts/link.mjs [--remove] [extensions folders...] (default: the existing ones of VS Code, Insiders and VSCodium)
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { publisher, name, version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const id = `${publisher}.${name}`;
const args = process.argv.slice(2);
const remove = args.includes('--remove');
const given = args.filter((arg) => arg !== '--remove');
const folders = given.length > 0 ? given
    : ['.vscode', '.vscode-insiders', '.vscode-oss'].map((dir) => join(homedir(), dir, 'extensions')).filter((dir) => existsSync(dir));
if (folders.length === 0) {
    console.error('No editor extensions folder found; pass one, for example ~/.vscode/extensions.');
    process.exit(1);
}

for (const folder of folders) {
    for (const entry of readdirSync(folder)) {
        if (entry.toLowerCase().startsWith(`${id}-`)) rmSync(join(folder, entry), { recursive: true, force: true });
    }
    const manifest = join(folder, 'extensions.json');
    const entries = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')) : [];
    const others = entries.filter((entry) => entry.identifier.id.toLowerCase() !== id);
    const link = join(folder, `${id}-${version}`);
    if (!remove) {
        symlinkSync(root, link, 'dir');
        const location = pathToFileURL(link);
        others.push({
            identifier: { id }, version, relativeLocation: `${id}-${version}`,
            location: { $mid: 1, fsPath: link, external: location.href, path: location.pathname, scheme: 'file' },
            metadata: { installedTimestamp: Date.now(), pinned: true, source: 'vsix' }
        });
    }
    writeFileSync(manifest, JSON.stringify(others));
    console.log(remove ? `Removed ${id} from ${folder}` : `Linked ${link} -> ${root}${lstatSync(link).isSymbolicLink() ? '' : ' (not a symlink)'}`);
}

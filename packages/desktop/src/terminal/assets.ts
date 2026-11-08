import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A file of the terminal (the panel page, its preload, the shell integration scripts). Built, they sit next to this
 * module in `out/terminal/`; in the packaged app the main process is one bundle in `out/` and `scripts/bundle.mjs`
 * copies them to `out/terminal/` beside it.
 */
export function asset(path: string, module: string = fileURLToPath(import.meta.url)): string {
    const folder = dirname(module);
    return basename(folder) === 'terminal' ? join(folder, path) : join(folder, 'terminal', path);
}

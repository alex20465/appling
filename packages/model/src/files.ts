import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The `.appling` files at a path, searching folders recursively and skipping hidden folders and `node_modules`. */
export function findApplingFiles(path: string): string[] {
    if (!statSync(path).isDirectory()) return [path];
    return readdirSync(path, { withFileTypes: true })
        .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules')
        .flatMap(e => e.isDirectory() ? findApplingFiles(join(path, e.name)) : e.name.endsWith('.appling') ? [join(path, e.name)] : []);
}

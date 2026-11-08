import { dirname, isAbsolute, relative } from 'node:path';

/**
 * The Appling projects of a VS Code workspace, without VS Code so it is tested on its own: a project is a folder whose
 * `.appling` files form one model, the folder its IDE server serves. A folder with `appling.config.json` is one; a
 * workspace folder with model files outside such a folder is another. Paths are absolute.
 */
export function projectRoots(folders: string[], configs: string[], models: string[]): string[] {
    const configured = configs.map(dirname);
    const loose = folders.filter(folder => models.some(model => inside(folder, model) && !configured.some(root => inside(root, model))));
    return [...new Set([...configured, ...loose])].sort();
}

/** The project a file belongs to: the innermost root that holds it. */
export function projectOf(roots: string[], file: string): string | undefined {
    return roots.filter(root => inside(root, file)).sort((a, b) => b.length - a.length)[0];
}

export function inside(folder: string, file: string): boolean {
    const rel = relative(folder, file);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

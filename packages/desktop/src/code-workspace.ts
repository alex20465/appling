import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fromVscodeUri, isRemoteId, locationId, parseLocation, toVscodeUri, type RemoteLocation } from './remote/location.js';

/** The extension of VS Code's multi root workspace files. */
export const EXTENSION = '.code-workspace';

/**
 * A folder of a workspace file; `name` is the optional display name VS Code shows instead of the folder's. `path` is
 * the repo's id: an absolute path, or for a remote folder (a `uri` entry) its URI (`ssh://host/path`, see `remote/location.ts`).
 */
export interface WorkspaceFolder {
    path: string;
    name?: string;
}

export interface CodeWorkspace {
    /** The local folders as absolute paths and the remote ones as repo URIs, in file order. */
    folders: WorkspaceFolder[];
    /** Every other key of the file (settings, extensions, launch, ...), and `folders` entries Desktop cannot open (other `uri` kinds), kept as they are. */
    data: Record<string, unknown>;
    remote: unknown[];
}

/** The workspace's name: the file name without `.code-workspace`, as VS Code shows it. */
export function workspaceName(file: string): string {
    const name = basename(file);
    return name.endsWith(EXTENSION) ? name.slice(0, -EXTENSION.length) : name;
}

/**
 * Removes comments and trailing commas outside strings. VS Code writes workspace files as JSON with comments,
 * and people commit them with both.
 */
export function stripJsonc(text: string): string {
    let out = '';
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '"') {
            let j = i + 1;
            while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
            out += text.slice(i, j + 1);
            i = j;
        } else if (c === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') i++;
            out += '\n';
        } else if (c === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2);
            i = end < 0 ? text.length : end + 1;
            out += ' ';
        } else if (c === ',') {
            let j = i + 1;
            while (j < text.length && /\s/.test(text[j])) j++;
            if (text[j] !== '}' && text[j] !== ']') out += c;
        } else out += c;
    }
    return out;
}

/** Reads the text of a workspace file; relative folder paths resolve against the file's folder. Throws when it is not a workspace. */
export function parseCodeWorkspace(text: string, file: string): CodeWorkspace {
    const json = JSON.parse(stripJsonc(text)) as unknown;
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error(`${file}: a workspace file holds an object`);
    const { folders = [], ...data } = json as Record<string, unknown>;
    if (!Array.isArray(folders)) throw new Error(`${file}: "folders" must be a list`);
    const local: WorkspaceFolder[] = [];
    const remote: unknown[] = [];
    for (const entry of folders) {
        const { path, name, uri } = (entry ?? {}) as { path?: unknown, name?: unknown, uri?: unknown };
        let folder: string;
        if (typeof path === 'string') folder = resolve(dirname(file), path);
        else {
            // VS Code's remote folders: vscode-remote://ssh-remote+host/path, wsl+distro, dev-container+<hex>
            try {
                folder = typeof uri === 'string' ? locationId(fromVscodeUri(uri)) : '';
            } catch {
                folder = '';
            }
            if (!folder) {
                remote.push(entry);
                continue;
            }
        }
        if (local.some(f => f.path === folder)) continue;
        local.push(typeof name === 'string' && name ? { path: folder, name } : { path: folder });
    }
    return { folders: local, data, remote };
}

/**
 * The text of a workspace file with these folders: paths relative to the file's folder (absolute when on another
 * drive), the other keys and remote folders of `previous` kept. Comments of the previous text are lost.
 */
export function printCodeWorkspace(file: string, folders: WorkspaceFolder[], previous?: CodeWorkspace): string {
    const entries = folders.map(folder => {
        if (isRemoteId(folder.path)) {
            const uri = toVscodeUri(parseLocation(folder.path) as RemoteLocation);
            return folder.name ? { name: folder.name, uri } : { uri };
        }
        const rel = relative(dirname(file), folder.path);
        const path = !rel ? '.' : isAbsolute(rel) ? folder.path : rel.split(sep).join('/');
        return folder.name ? { name: folder.name, path } : { path };
    });
    return `${JSON.stringify({ folders: [...entries, ...(previous?.remote ?? [])], ...previous?.data }, null, '\t')}\n`;
}

export function readCodeWorkspace(file: string): CodeWorkspace {
    return parseCodeWorkspace(readFileSync(file, 'utf8'), file);
}

/**
 * Writes the folders into the file and keeps what else it holds; creates the file and its folder when missing.
 * Throws, writing nothing, when the existing file does not parse, so a hand edited file is never overwritten.
 */
export function writeCodeWorkspace(file: string, folders: WorkspaceFolder[]): void {
    const previous = existsSync(file) ? readCodeWorkspace(file) : undefined;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, printCodeWorkspace(file, folders, previous));
}

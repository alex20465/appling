import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/** Where VS Code's `code` command lives when it is not on the PATH (the macOS app does not add it by itself). */
const FALLBACKS: Record<string, string[]> = {
    darwin: ['/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code', '/usr/local/bin/code'],
    linux: ['/usr/bin/code', '/snap/bin/code'],
    win32: []
};

/** VS Code's `code` command: on the PATH, else in its usual install folder; undefined when VS Code is not found. */
export function findCode(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, exists: (path: string) => boolean = existsSync): string | undefined {
    const names = platform === 'win32' ? ['code.cmd', 'code.exe'] : ['code'];
    for (const dir of (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean)) {
        for (const name of names) {
            const path = join(dir, name);
            if (exists(path)) return path;
        }
    }
    return (FALLBACKS[platform] ?? []).find(path => exists(path));
}

/** The 1 based line and column of an offset into a text. */
export function lineColumn(text: string, offset: number): { line: number, column: number } {
    const before = text.slice(0, Math.max(0, offset));
    const lines = before.split('\n');
    return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

/** The `code` arguments that open the repo, and in it a file at a line and column when one is given. */
export function vscodeArgs(repo: string, file?: { path: string, line?: number, column?: number }): string[] {
    if (!file) return [repo];
    const at = file.line ? `:${file.line}${file.column ? `:${file.column}` : ''}` : '';
    return [repo, '--goto', `${file.path}${at}`];
}

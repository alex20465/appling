import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';

/** A host of `~/.ssh/config` that the add remote form offers: a `Host` alias without wildcards and what it sets. */
export interface SshHost {
    alias: string;
    hostName?: string;
    user?: string;
    port?: number;
}

/**
 * The hosts of an ssh config text, in file order: every alias of a `Host` line without wildcards or negation, with the
 * first `HostName`, `User` and `Port` that applies to it (ssh's rule: the first value wins, from any block whose
 * patterns match, also `Host *` and lines before the first block). `Match` blocks are skipped; `Include` lines are
 * handed to `include`, which returns the texts of the files they name, read in place as ssh does.
 */
export function parseSshConfig(text: string, include: (pattern: string) => string[] = () => []): SshHost[] {
    const aliases: string[] = [];
    const settings: Setting[] = [];
    collect(text, include, aliases, settings, { patterns: undefined });
    return aliases.map(alias => {
        const host: SshHost = { alias };
        for (const setting of settings) {
            if (setting.patterns === null || setting.patterns && !applies(setting.patterns, alias)) continue;
            if (host[setting.field] === undefined) (host as unknown as Record<string, unknown>)[setting.field] = setting.value;
        }
        return host;
    });
}

/** A HostName, User or Port line and the patterns of its block (`undefined` before any Host line, `null` in a Match block). */
interface Setting {
    patterns: string[] | undefined | null;
    field: 'hostName' | 'user' | 'port';
    value: string | number;
}

function collect(text: string, include: (pattern: string) => string[], aliases: string[], settings: Setting[], block: { patterns: string[] | undefined | null }): void {
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/(^|\s)#.*$/, '').trim();
        const match = /^(\S+?)(?:\s*=\s*|\s+)(.*)$/.exec(line);
        if (!match) continue;
        const keyword = match[1].toLowerCase();
        const args = words(match[2]);
        if (keyword === 'include') {
            for (const pattern of args) for (const included of include(pattern)) collect(included, include, aliases, settings, block);
        } else if (keyword === 'host') {
            block.patterns = args;
            for (const alias of args) if (!/[*?!]/.test(alias) && !aliases.includes(alias)) aliases.push(alias);
        } else if (keyword === 'match') {
            block.patterns = null;
        } else {
            const field = keyword === 'hostname' ? 'hostName' : keyword === 'user' ? 'user' : keyword === 'port' ? 'port' : undefined;
            if (!field || !args[0]) continue;
            const value = field === 'port' ? Number(args[0]) : args[0];
            if (field === 'port' && !(Number.isInteger(value) && (value as number) > 0)) continue;
            settings.push({ patterns: block.patterns, field, value });
        }
    }
}

/** The words of an ssh config value, double quotes kept together. */
function words(text: string): string[] {
    return [...text.matchAll(/"([^"]*)"|(\S+)/g)].map(m => m[1] ?? m[2]);
}

/** Whether a name matches a list of ssh patterns (`*`, `?`, `!` negation, case insensitive). */
export function applies(patterns: string[], alias: string): boolean {
    let matched = false;
    for (const pattern of patterns) {
        const negated = pattern.startsWith('!');
        const glob = new RegExp(`^${(negated ? pattern.slice(1) : pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
        if (!glob.test(alias)) continue;
        if (negated) return false;
        matched = true;
    }
    return matched;
}

/** The user's ssh config file. */
export function sshConfigFile(home = homedir()): string {
    return join(home, '.ssh', 'config');
}

/**
 * The hosts of the user's ssh config, following `Include` (relative to `~/.ssh`, `~` expanded, `*` in the file name).
 * No file is no hosts.
 */
export function readSshHosts(file = sshConfigFile(), home = homedir()): SshHost[] {
    const read = (path: string) => {
        try {
            return readFileSync(path, 'utf8');
        } catch {
            return undefined;
        }
    };
    const seen = new Set<string>();
    const include = (pattern: string): string[] => {
        const expanded = pattern.startsWith('~') ? join(home, pattern.slice(1)) : isAbsolute(pattern) ? pattern : join(home, '.ssh', pattern);
        const name = basename(expanded);
        const dir = dirname(expanded);
        const files = /[*?]/.test(name)
            ? existsSync(dir) ? readdirSync(dir).filter(f => applies([name], f)).sort().map(f => join(dir, f)) : []
            : [expanded];
        return files.filter(f => !seen.has(f) && seen.add(f) && existsSync(f) && statSync(f).isFile()).map(f => read(f) ?? '');
    };
    const text = read(file);
    return text === undefined ? [] : parseSshConfig(text, include);
}

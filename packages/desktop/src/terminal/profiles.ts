import { basename, join } from 'node:path';

/**
 * Terminal profiles: the shells a new terminal can run. They come from `$SHELL`, the shells listed in `/etc/shells`
 * (Windows: PowerShell and the Command Prompt) and VS Code's `terminal.integrated.profiles.<os>` settings, which add,
 * change or (with `null`) remove profiles by name, the way VS Code reads them.
 */

export interface TerminalProfile {
    name: string;
    path: string;
    args: string[];
    /** Added to the terminal's environment; `null` removes a variable. */
    env?: Record<string, string | null>;
    icon?: string;
    color?: string;
    /** Where the profile comes from: found on the system, or written in the settings. */
    source: 'detected' | 'settings';
}

/** A profile as VS Code's settings write it. */
interface VsCodeProfile {
    path?: string | string[];
    args?: string | string[];
    env?: Record<string, string | null>;
    icon?: string;
    color?: string;
    /** Windows only: `PowerShell` or `Git Bash`, found by VS Code itself. */
    source?: string;
}

export type Platform = 'linux' | 'darwin' | 'win32';

export interface ProfileContext {
    platform: Platform;
    env: Record<string, string | undefined>;
    /** Whether an executable exists at the path. */
    exists(path: string): boolean;
    /** The text of `/etc/shells`, if there is one. */
    shells?: string;
    /**
     * Settings objects with flat keys, lowest priority first: VS Code's user settings, the workspace file's
     * `settings`, the repo's `.vscode/settings.json`, then Appling Desktop's own settings.
     */
    settings: Record<string, unknown>[];
    /** The repo, for `${workspaceFolder}`. */
    workspaceFolder?: string;
}

export interface Profiles {
    profiles: TerminalProfile[];
    /** The name of the profile a new terminal uses. */
    default?: string;
    /** Profiles of the settings that were skipped, with the reason. */
    problems: string[];
}

/** The key of VS Code's settings for the platform: `linux`, `osx` or `windows`. */
export function osKey(platform: Platform): 'linux' | 'osx' | 'windows' {
    return platform === 'win32' ? 'windows' : platform === 'darwin' ? 'osx' : 'linux';
}

export function terminalProfiles(context: ProfileContext): Profiles {
    const problems: string[] = [];
    const profiles = new Map<string, TerminalProfile>();
    for (const profile of detected(context)) if (!profiles.has(profile.name)) profiles.set(profile.name, profile);

    const os = osKey(context.platform);
    const configured = new Map<string, VsCodeProfile | null>();
    for (const layer of context.settings) {
        const value = layer[`terminal.integrated.profiles.${os}`];
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        for (const [name, profile] of Object.entries(value)) configured.set(name, profile as VsCodeProfile | null);
    }
    for (const [name, profile] of configured) {
        if (profile === null) {
            profiles.delete(name);
            continue;
        }
        if (typeof profile !== 'object') {
            problems.push(`profile "${name}": expected an object or null`);
            continue;
        }
        const found = resolveProfile(name, profile, context, profiles);
        if (typeof found === 'string') problems.push(`profile "${name}": ${found}`);
        else profiles.set(name, found);
    }

    const list = [...profiles.values()];
    const wanted = [
        setting(context, 'terminal.defaultProfile'),
        setting(context, `terminal.integrated.defaultProfile.${os}`)
    ].find(name => typeof name === 'string' && profiles.has(name)) as string | undefined;
    const shell = context.env.SHELL;
    const byShell = shell ? list.find(p => p.path === shell) ?? list.find(p => p.name === basename(shell)) : undefined;
    return { profiles: list, default: wanted ?? byShell?.name ?? list[0]?.name, problems };
}

/** The highest priority value of a setting. */
function setting(context: ProfileContext, key: string): unknown {
    for (let i = context.settings.length - 1; i >= 0; i--) {
        if (context.settings[i][key] !== undefined) return context.settings[i][key];
    }
    return undefined;
}

function resolveProfile(name: string, profile: VsCodeProfile, context: ProfileContext, known: Map<string, TerminalProfile>): TerminalProfile | string {
    const base = profile.source ? [...known.values()].find(p => p.name === profile.source) : undefined;
    if (profile.source && !base && profile.path === undefined) return `source "${profile.source}" was not found`;
    const paths = (profile.path === undefined ? [] : Array.isArray(profile.path) ? profile.path : [profile.path]).map(p => substitute(String(p), context));
    let path = base?.path;
    if (paths.length) {
        path = paths.find(p => context.exists(p)) ?? paths.map(p => findOnPath(p, context)).find(Boolean);
        if (!path) return `none of ${paths.join(', ')} exists`;
    }
    if (!path) return 'it has no path';
    const args = profile.args === undefined ? base?.args ?? [] : (Array.isArray(profile.args) ? profile.args : [profile.args]).map(a => substitute(String(a), context));
    const env = profile.env && typeof profile.env === 'object'
        ? Object.fromEntries(Object.entries(profile.env).map(([k, v]) => [k, v === null ? null : substitute(String(v), context)]))
        : undefined;
    return {
        name, path, args,
        ...env ? { env } : {},
        ...typeof profile.icon === 'string' ? { icon: profile.icon } : {},
        ...typeof profile.color === 'string' ? { color: profile.color } : {},
        source: 'settings'
    };
}

/** VS Code's variables in profile paths, arguments and environment values. */
export function substitute(text: string, context: ProfileContext): string {
    return text.replace(/\$\{(env:([^}]+)|userHome|workspaceFolder|pathSeparator)\}/g, (whole, key: string, variable?: string) => {
        if (variable) return context.env[variable] ?? '';
        if (key === 'userHome') return context.env.HOME ?? context.env.USERPROFILE ?? '';
        if (key === 'workspaceFolder') return context.workspaceFolder ?? whole;
        return context.platform === 'win32' ? '\\' : '/';
    });
}

/** A bare command name (`zsh`, `pwsh.exe`) looked up on `PATH`. */
function findOnPath(command: string, context: ProfileContext): string | undefined {
    if (/[\\/]/.test(command)) return undefined;
    const separator = context.platform === 'win32' ? ';' : ':';
    const join_ = context.platform === 'win32' ? (dir: string) => `${dir.replace(/[\\/]$/, '')}\\${command}` : (dir: string) => join(dir, command);
    for (const dir of (context.env.PATH ?? context.env.Path ?? '').split(separator).filter(Boolean)) {
        const candidate = join_(dir);
        if (context.exists(candidate)) return candidate;
    }
    return undefined;
}

/** The shells found on the system: `$SHELL` first, then those of `/etc/shells` (Windows: PowerShell, Command Prompt, Git Bash). */
function detected(context: ProfileContext): TerminalProfile[] {
    const profile = (name: string, path: string, args: string[] = []): TerminalProfile => ({ name, path, args, source: 'detected' });
    if (context.platform === 'win32') {
        const found: TerminalProfile[] = [];
        const pwsh = findOnPath('pwsh.exe', context);
        const root = context.env.SystemRoot ?? context.env.windir ?? 'C:\\Windows';
        const powershell = pwsh ?? [`${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`].find(p => context.exists(p));
        if (powershell) found.push(profile('PowerShell', powershell));
        const cmd = context.env.ComSpec ?? context.env.COMSPEC ?? `${root}\\System32\\cmd.exe`;
        if (context.exists(cmd)) found.push(profile('Command Prompt', cmd));
        const programs = context.env.ProgramFiles ?? 'C:\\Program Files';
        const gitBash = `${programs}\\Git\\bin\\bash.exe`;
        if (context.exists(gitBash)) found.push(profile('Git Bash', gitBash, ['--login', '-i']));
        return found;
    }
    const paths = [context.env.SHELL, ...(context.shells ?? '').split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'))];
    const found: TerminalProfile[] = [];
    for (const path of paths) {
        if (!path || !path.startsWith('/') || !context.exists(path)) continue;
        const name = basename(path);
        // /etc/shells lists the same shell under /bin and /usr/bin; nologin and the like are not shells to open
        if (found.some(p => p.name === name) || /nologin|false|true|sync|shutdown|halt/.test(name)) continue;
        found.push(profile(name, path));
    }
    if (!found.length) found.push(profile('sh', '/bin/sh'));
    return found;
}

/** VS Code's user settings files for the platform, the stable build first (Insiders and VSCodium also count). */
export function vscodeSettingsFiles(platform: Platform, env: Record<string, string | undefined>, home: string): string[] {
    const base = platform === 'win32' ? env.APPDATA ?? join(home, 'AppData', 'Roaming')
        : platform === 'darwin' ? join(home, 'Library', 'Application Support')
        : env.XDG_CONFIG_HOME ?? join(home, '.config');
    return ['Code', 'Code - Insiders', 'VSCodium'].map(product => join(base, product, 'User', 'settings.json'));
}

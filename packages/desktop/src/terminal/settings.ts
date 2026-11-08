import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { stripJsonc } from '../code-workspace.js';

/** The terminal settings of Appling Desktop, read from `settings.json` in the user data folder. */
export interface TerminalSettings {
    /** End every terminal when the app quits, instead of keeping them running for the next start. */
    endWithApp: boolean;
    /** The profile new terminals use; VS Code's default profile setting, then `$SHELL`, when unset. */
    defaultProfile?: string;
    /** Inject the shell integration scripts into bash, zsh and fish. */
    shellIntegration: boolean;
    /** Lines kept above the screen. */
    scrollback: number;
    fontSize: number;
    fontFamily: string;
    cursorBlink: boolean;
}

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
    endWithApp: false,
    shellIntegration: true,
    scrollback: 10000,
    fontSize: 13,
    fontFamily: 'ui-monospace, "JetBrains Mono", "Cascadia Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
    cursorBlink: false
};

/** Each setting with its key in `settings.json`, its type and, where VS Code has one, VS Code's key to fall back to. */
const KEYS: Record<keyof TerminalSettings, { key: string, type: 'boolean' | 'string' | 'number', vscode?: string, min?: number, max?: number }> = {
    endWithApp: { key: 'terminal.endWithApp', type: 'boolean' },
    defaultProfile: { key: 'terminal.defaultProfile', type: 'string' },
    shellIntegration: { key: 'terminal.shellIntegration', type: 'boolean', vscode: 'terminal.integrated.shellIntegration.enabled' },
    scrollback: { key: 'terminal.scrollback', type: 'number', vscode: 'terminal.integrated.scrollback', min: 0, max: 1_000_000 },
    fontSize: { key: 'terminal.fontSize', type: 'number', vscode: 'terminal.integrated.fontSize', min: 6, max: 72 },
    fontFamily: { key: 'terminal.fontFamily', type: 'string', vscode: 'terminal.integrated.fontFamily' },
    cursorBlink: { key: 'terminal.cursorBlink', type: 'boolean', vscode: 'terminal.integrated.cursorBlinking' }
};

/** The key of the end-with-the-app setting in `settings.json`. */
export const END_WITH_APP = KEYS.endWithApp.key;

/** A settings file as an object; a missing file is empty, a broken one is reported. */
export function readSettingsFile(file: string): { settings: Record<string, unknown>, problems: string[] } {
    if (!existsSync(file)) return { settings: {}, problems: [] };
    try {
        const value = JSON.parse(stripJsonc(readFileSync(file, 'utf8')) || '{}');
        if (!value || typeof value !== 'object' || Array.isArray(value)) return { settings: {}, problems: [`${file}: expected an object`] };
        return { settings: value, problems: [] };
    } catch (error) {
        return { settings: {}, problems: [`${file}: ${(error as Error).message}`] };
    }
}

/**
 * The terminal settings from Appling's own settings over VS Code's (`terminal.integrated.*`) over the defaults.
 * A value of the wrong type is skipped and reported, VS Code's are taken only when they fit.
 */
export function terminalSettings(own: Record<string, unknown>, vscode: Record<string, unknown> = {}): { settings: TerminalSettings, problems: string[] } {
    const settings: TerminalSettings = { ...DEFAULT_TERMINAL_SETTINGS };
    const problems: string[] = [];
    const fits = (spec: typeof KEYS[keyof TerminalSettings], value: unknown) =>
        typeof value === spec.type && (spec.type !== 'number' || (Number.isFinite(value) && (value as number) >= (spec.min ?? -Infinity) && (value as number) <= (spec.max ?? Infinity)))
        && (spec.type !== 'string' || (value as string).trim() !== '');
    for (const [name, spec] of Object.entries(KEYS) as [keyof TerminalSettings, typeof KEYS[keyof TerminalSettings]][]) {
        const value = own[spec.key];
        if (value !== undefined) {
            if (fits(spec, value)) (settings as unknown as Record<string, unknown>)[name] = value;
            else problems.push(`"${spec.key}" must be a${spec.type === 'number' ? ` number${spec.min !== undefined ? ` from ${spec.min} to ${spec.max}` : ''}` : spec.type === 'boolean' ? ' boolean' : ' non empty string'}`);
        } else if (spec.vscode && fits(spec, vscode[spec.vscode])) {
            (settings as unknown as Record<string, unknown>)[name] = vscode[spec.vscode];
        }
    }
    return { settings, problems };
}

/** Sets one key of a settings file and keeps the others (comments are lost on that write). */
export function writeSetting(file: string, key: string, value: unknown): void {
    const { settings, problems } = readSettingsFile(file);
    if (problems.length) throw new Error(problems.join('\n'));
    settings[key] = value;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
}

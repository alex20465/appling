import { existsSync, readFileSync } from 'node:fs';
import type { Lifecycle } from './code-instances.js';

/** The `codeView` section of the app's `settings.json`. */
export interface CodeViewSettings {
    /** `lazy` (start on first open, suspend after idle) or `always` (run while the repo is open). */
    lifecycle: Lifecycle;
    /** Minutes a lazy code view may stay out of sight before its instance is suspended. */
    idleMinutes: number;
    /** The code view's share of the repo's width, between 0.2 and 0.8. */
    width: number;
}

export const DEFAULT_CODE_VIEW: CodeViewSettings = { lifecycle: 'lazy', idleMinutes: 15, width: 0.5 };

/**
 * Reads the `codeView` section of a settings file over the defaults; a malformed value is skipped and reported, so a
 * typo never keeps the code view from opening. Other sections of the file belong to other parts of the app.
 */
export function loadCodeViewSettings(file: string): { settings: CodeViewSettings, problems: string[] } {
    const settings = { ...DEFAULT_CODE_VIEW };
    const problems: string[] = [];
    if (!existsSync(file)) return { settings, problems };
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
        return { settings, problems: [`${file}: ${(error as Error).message}`] };
    }
    const section = (parsed as { codeView?: unknown } | null)?.codeView;
    if (section === undefined) return { settings, problems };
    if (!section || typeof section !== 'object' || Array.isArray(section)) return { settings, problems: ['codeView: expected an object'] };
    for (const [key, value] of Object.entries(section)) {
        if (key === 'lifecycle') {
            if (value === 'lazy' || value === 'always') settings.lifecycle = value;
            else problems.push(`codeView.lifecycle: expected "lazy" or "always", got ${JSON.stringify(value)}`);
        } else if (key === 'idleMinutes') {
            if (typeof value === 'number' && value > 0) settings.idleMinutes = value;
            else problems.push(`codeView.idleMinutes: expected a positive number, got ${JSON.stringify(value)}`);
        } else if (key === 'width') {
            if (typeof value === 'number' && value >= 0.2 && value <= 0.8) settings.width = value;
            else problems.push(`codeView.width: expected a number from 0.2 to 0.8, got ${JSON.stringify(value)}`);
        } else problems.push(`codeView.${key}: unknown setting`);
    }
    return { settings, problems };
}

export interface Bounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Splits a repo's area: the IDE view on the left, the code view (when shown) on the right; hidden, the IDE fills it. */
export function splitBounds(area: Bounds, shown: boolean, width: number): { ide: Bounds, code?: Bounds } {
    if (!shown) return { ide: area };
    const code = Math.round(area.width * width);
    return {
        ide: { ...area, width: area.width - code },
        code: { ...area, x: area.x + area.width - code, width: code }
    };
}

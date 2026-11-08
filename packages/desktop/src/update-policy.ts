/** Where Desktop releases live: GitHub Releases of the repository, tagged `desktop-v<version>`. */
export const RELEASES = 'https://github.com/alex20465/appling/releases';

/** The release page of one version, for a manual download. */
export function releaseUrl(version?: string): string {
    return version ? `${RELEASES}/tag/desktop-v${version}` : `${RELEASES}/latest`;
}

/**
 * How this copy updates: `auto` downloads and installs a new version itself, `manual` only tells about it and points to
 * the release page, `none` does not look.
 */
export type UpdateMode = 'auto' | 'manual' | 'none';

export interface UpdateEnvironment {
    /** Runs from an installed package, not from the workspace. */
    packaged: boolean;
    platform: NodeJS.Platform;
    /** The AppImage's path (`APPIMAGE`), set when the Linux build runs from its AppImage. */
    appImage?: string;
    /** The build was code signed (`signed` in the packaged `package.json`, set by the builder config). */
    signed: boolean;
    /** `APPLING_DISABLE_UPDATES`: never look, for managed installs. */
    disabled?: string;
}

/**
 * The update mode with the reason a person reads when it is not `auto`. electron-updater replaces an AppImage and
 * installs an NSIS update unsigned, but macOS installs only signed updates, so an unsigned Mac build is `manual`.
 */
export function updateMode(env: UpdateEnvironment): { mode: UpdateMode, reason?: string } {
    if (!env.packaged) return { mode: 'none', reason: 'Appling Desktop runs from the workspace; only the installed app updates itself.' };
    if (env.disabled && env.disabled !== '0') return { mode: 'none', reason: 'Updates are turned off by APPLING_DISABLE_UPDATES.' };
    if (env.platform === 'linux' && !env.appImage) {
        return { mode: 'manual', reason: 'This copy does not run from its AppImage, so it cannot replace itself.' };
    }
    if (env.platform === 'darwin' && !env.signed) {
        return { mode: 'manual', reason: 'This build is not signed, and macOS installs only signed updates.' };
    }
    return { mode: 'auto' };
}

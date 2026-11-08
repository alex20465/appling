import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, dialog, shell, type BaseWindow } from 'electron';
import electronUpdater from 'electron-updater';
import { releaseUrl, updateMode, type UpdateMode } from './update-policy.js';

const { autoUpdater } = electronUpdater;

/** Whether the builder config marked this build as signed (see `electron-builder.config.mjs`). */
function signed(): boolean {
    try {
        return (JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) as { signed?: boolean }).signed === true;
    } catch {
        return false;
    }
}

/**
 * Updates from GitHub Releases through electron-updater: a quiet check on start and an interactive one from the menu.
 * Where the app cannot replace itself (see `updateMode`) it only reports a new version and opens its release page.
 */
export class Updater {
    readonly mode: UpdateMode;
    private readonly reason?: string;
    private checking = false;

    constructor(private readonly window: () => BaseWindow | undefined) {
        const { mode, reason } = updateMode({
            packaged: app.isPackaged, platform: process.platform, appImage: process.env.APPIMAGE, signed: signed(),
            disabled: process.env.APPLING_DISABLE_UPDATES
        });
        this.mode = mode;
        this.reason = reason;
        if (mode === 'none') return;
        autoUpdater.autoDownload = mode === 'auto';
        autoUpdater.autoInstallOnAppQuit = mode === 'auto';
        autoUpdater.on('update-downloaded', info => this.ask({
            type: 'info', message: `Appling ${info.version} is ready`, detail: 'Restart now to use it, or it installs when you quit.',
            buttons: ['Restart Now', 'Later'], defaultId: 0, cancelId: 1
        }).then(button => button === 0 && autoUpdater.quitAndInstall()));
    }

    /** The quiet check on start: says something only when a new version needs a manual download. */
    start(): void {
        if (this.mode !== 'none') this.check(false);
    }

    /** Looks for a new version. Interactive checks (from the menu) also report "up to date" and errors. */
    async check(interactive = true): Promise<void> {
        if (this.mode === 'none') {
            if (interactive) await this.ask({ type: 'info', message: 'Updates are not available here', detail: this.reason, buttons: ['OK'] });
            return;
        }
        if (this.checking) return;
        this.checking = true;
        try {
            const result = await autoUpdater.checkForUpdates();
            const version = result?.isUpdateAvailable ? result.updateInfo.version : undefined;
            if (!version) {
                if (interactive) await this.ask({ type: 'info', message: 'Appling is up to date', detail: `Version ${app.getVersion()} is the latest.`, buttons: ['OK'] });
            } else if (this.mode === 'manual') {
                const button = await this.ask({
                    type: 'info', message: `Appling ${version} is available`, detail: `${this.reason} Download it from the release page.`,
                    buttons: ['Download', 'Later'], defaultId: 0, cancelId: 1
                });
                if (button === 0) shell.openExternal(releaseUrl(version));
            } else if (interactive) {
                await this.ask({ type: 'info', message: `Downloading Appling ${version}`, detail: 'Appling asks to restart once it is ready.', buttons: ['OK'] });
            }
        } catch (error) {
            console.error(`Appling Desktop update check: ${(error as Error).message}`);
            if (interactive) {
                const button = await this.ask({
                    type: 'warning', message: 'The update check failed', detail: `${(error as Error).message.split('\n')[0]}\n\nYou can download new versions from the release page.`,
                    buttons: ['Open Releases', 'OK'], defaultId: 1, cancelId: 1
                });
                if (button === 0) shell.openExternal(releaseUrl());
            }
        } finally {
            this.checking = false;
        }
    }

    private async ask(options: Electron.MessageBoxOptions): Promise<number> {
        const window = this.window();
        return (await (window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options))).response;
    }
}

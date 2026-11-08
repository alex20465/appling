import { spawnSync } from 'node:child_process';
import { dialog, ipcMain, type BaseWindow, type WebContents } from 'electron';
import { findDevcontainer } from './devcontainer.js';
import { locationId, parseLocation } from './location.js';
import { readSshHosts } from './ssh-config.js';

export interface RemoteFormHost {
    /** The window the form opens in, for the folder dialog. */
    window(): BaseWindow | undefined;
    /** That window's shell page, which draws the form. */
    shell(): WebContents | undefined;
    /** Called when the form opens and closes, so the main process hides the repo views behind the shell page. */
    shown(open: boolean): void;
    /** Adds the repo (its id) to the active workspace. */
    add(id: string): void;
}

/** The WSL distributions (`wsl.exe -l -q`, which prints UTF-16); none outside Windows. */
export function wslDistros(): string[] {
    if (process.platform !== 'win32') return [];
    const result = spawnSync('wsl.exe', ['-l', '-q'], { windowsHide: true, timeout: 10000 });
    if (result.status !== 0 || !result.stdout) return [];
    return parseWslList(result.stdout);
}

/** The names `wsl.exe -l -q` prints, UTF-16LE with a byte order mark or not. */
export function parseWslList(output: Buffer): string[] {
    const text = output.includes(0) ? output.toString('utf16le') : output.toString('utf8');
    return text.replace(/^﻿/, '').split(/\r?\n/).map(line => line.replace(/\0/g, '').trim()).filter(Boolean);
}

/** What the remote form proposes: `ssh://<alias>/` per host of `~/.ssh/config`, `wsl://<distro>/` per distribution. */
export function remoteSuggestions(): string[] {
    return [...readSshHosts().map(host => `ssh://${host.alias}/`), ...wslDistros().map(distro => `wsl://${distro}/`)];
}

/**
 * The remote repo form: the shell page draws it (one field, `ssh://host/path` or `wsl://distro/path`, with the hosts
 * of `~/.ssh/config` and the WSL distributions to pick), the main process checks the text and adds the repo. Returns
 * the function that opens the form, and the one that adds a local folder's dev container.
 */
export function remoteIpc(host: RemoteFormHost): { open(): void, openContainer(folder?: string): Promise<void> } {
    ipcMain.handle('addRemote', (_event, text: string) => {
        try {
            const location = parseLocation(String(text ?? '').trim());
            if (location.kind === 'local') return { error: 'Give a remote folder: ssh://host/path, wsl://distro/path or devcontainer:///local/folder.' };
            if (location.kind === 'container' && !findDevcontainer(location.folder)) return { error: `${location.folder} has no .devcontainer/devcontainer.json.` };
            host.shown(false);
            host.add(locationId(location));
            return { id: locationId(location) };
        } catch (error) {
            return { error: (error as Error).message };
        }
    });
    ipcMain.on('closeRemote', () => host.shown(false));
    const openContainer = async (folder?: string) => {
        const window = host.window();
        if (!folder) {
            if (!window) return;
            const result = await dialog.showOpenDialog(window, { title: 'Open Folder in Dev Container', properties: ['openDirectory'] });
            if (result.canceled || !result.filePaths[0]) return;
            folder = result.filePaths[0];
        }
        if (!findDevcontainer(folder)) {
            dialog.showErrorBox('No dev container', `${folder} has no .devcontainer/devcontainer.json or .devcontainer.json.`);
            return;
        }
        host.add(locationId({ kind: 'container', folder }));
    };
    return {
        open: () => {
            host.shown(true);
            const shell = host.shell();
            if (!shell) return host.shown(false);
            shell.focus();
            shell.send('remote', { suggestions: remoteSuggestions() });
        },
        openContainer
    };
}

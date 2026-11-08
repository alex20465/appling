import { homedir } from 'node:os';
import { dialog, ipcMain, type BaseWindow, type WebContents } from 'electron';
import { cloneRepo, defaultCloneParent } from './clone.js';

export interface CloneHost {
    /** The window the form opens in, for the folder dialog. */
    window(): BaseWindow | undefined;
    /** That window's shell page, which draws the form. */
    shell(): WebContents | undefined;
    /** The folders of the workspace the clone goes to, for the proposed parent folder. */
    folders(): string[];
    /** Called when the form opens and closes, so the main process hides the repo views behind the shell page. */
    shown(open: boolean): void;
    /** Adds the cloned folder to the active workspace. */
    add(folder: string): void;
}

/**
 * The clone form: the shell page draws it (URL, parent folder, progress, git's error), the main process runs
 * `git clone` and adds the new folder to the active workspace. Returns the function that opens the form.
 */
export function cloneIpc(host: CloneHost): () => void {
    let running: AbortController | undefined;
    const close = () => {
        running?.abort();
        running = undefined;
        host.shown(false);
    };
    ipcMain.handle('chooseCloneParent', async (_event, current: string) => {
        const window = host.window();
        if (!window) return undefined;
        const result = await dialog.showOpenDialog(window, { title: 'Clone into', defaultPath: current, properties: ['openDirectory', 'createDirectory'] });
        return result.canceled ? undefined : result.filePaths[0];
    });
    ipcMain.handle('clone', async (_event, url: string, parent: string, name?: string) => {
        running?.abort();
        const controller = running = new AbortController();
        try {
            const folder = await cloneRepo(String(url ?? ''), String(parent ?? ''), {
                name: name || undefined,
                signal: controller.signal,
                onProgress: progress => host.shell()?.send('cloneProgress', progress)
            });
            if (controller.signal.aborted) return { error: 'The clone was cancelled.' };
            running = undefined;
            host.shown(false);
            host.add(folder);
            return { folder };
        } catch (error) {
            if (running === controller) running = undefined;
            return { error: (error as Error).message };
        }
    });
    ipcMain.on('closeClone', close);
    return () => {
        const shell = host.shell();
        if (!shell) return;
        host.shown(true);
        shell.focus();
        shell.send('clone', { parent: defaultCloneParent(host.folders(), homedir()) });
    };
}

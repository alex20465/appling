import { contextBridge, ipcRenderer } from 'electron';

/** The only bridge between the shell page (rail) and the main process. */
contextBridge.exposeInMainWorld('appling', {
    state: () => ipcRenderer.invoke('state'),
    onState: (callback: (state: unknown) => void) => ipcRenderer.on('state', (_event, state) => callback(state)),
    select: (repo: string, workspace?: string) => ipcRenderer.send('select', repo, workspace),
    selectWorkspace: (id: string) => ipcRenderer.send('selectWorkspace', id),
    close: (repo: string) => ipcRenderer.send('close', repo),
    retry: (repo: string) => ipcRenderer.send('retry', repo),
    open: () => ipcRenderer.send('open'),
    newWorkspace: () => ipcRenderer.send('newWorkspace'),
    repoMenu: (repo: string) => ipcRenderer.send('repoMenu', repo),
    workspaceMenu: (id: string) => ipcRenderer.send('workspaceMenu', id)
});

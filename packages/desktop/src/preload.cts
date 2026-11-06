import { contextBridge, ipcRenderer } from 'electron';

/** The only bridge between the shell page (rail) and the main process. */
contextBridge.exposeInMainWorld('appling', {
    state: () => ipcRenderer.invoke('state'),
    onState: (callback: (state: unknown) => void) => ipcRenderer.on('state', (_event, state) => callback(state)),
    select: (id: string) => ipcRenderer.send('select', id),
    close: (id: string) => ipcRenderer.send('close', id),
    retry: (id: string) => ipcRenderer.send('retry', id),
    open: () => ipcRenderer.send('open')
});

import { contextBridge, ipcRenderer } from 'electron';

/** The only bridge between a repo's terminal panel page and the main process; the main process knows the repo by the sender. */
const on = (channel: string) => (callback: (...args: unknown[]) => void) => ipcRenderer.on(channel, (_event, ...args) => callback(...args));

contextBridge.exposeInMainWorld('terminals', {
    layout: () => ipcRenderer.invoke('terminal:layout'),
    onLayout: on('terminal:layout'),
    attach: (id: string, cols: number, rows: number) => ipcRenderer.send('terminal:attach', id, cols, rows),
    onSnapshot: on('terminal:snapshot'),
    onData: on('terminal:data'),
    onExit: on('terminal:exit'),
    onCommand: on('terminal:command'),
    input: (id: string, data: string) => ipcRenderer.send('terminal:input', id, data),
    resize: (id: string, cols: number, rows: number) => ipcRenderer.send('terminal:resize', id, cols, rows),
    create: (options: { profile?: string, split?: boolean }) => ipcRenderer.send('terminal:create', options),
    profileMenu: (split: boolean) => ipcRenderer.send('terminal:profileMenu', split),
    tabMenu: (id: string) => ipcRenderer.send('terminal:tabMenu', id),
    close: (id: string) => ipcRenderer.send('terminal:close', id),
    focus: (id: string) => ipcRenderer.send('terminal:focus', id),
    rename: (id: string, name: string) => ipcRenderer.send('terminal:rename', id, name),
    moveTab: (id: string, to: number) => ipcRenderer.send('terminal:moveTab', id, to),
    hide: () => ipcRenderer.send('terminal:hide'),
    resizePanel: (deltaY: number) => ipcRenderer.send('terminal:resizePanel', deltaY),
    openLink: (id: string, uri: string) => ipcRenderer.send('terminal:openLink', id, uri),
    resolveFile: (id: string, path: string) => ipcRenderer.invoke('terminal:resolveFile', id, path),
    openFile: (id: string, path: string, line?: number, column?: number) => ipcRenderer.send('terminal:openFile', id, path, line, column),
    copy: (text: string) => ipcRenderer.send('terminal:copy', text),
    paste: () => ipcRenderer.invoke('terminal:paste')
});

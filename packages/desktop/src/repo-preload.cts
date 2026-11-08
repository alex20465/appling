import { contextBridge, ipcRenderer } from 'electron';

/**
 * The bridge between a repo's IDE view and the main process, for the code view's selection sync: the IDE reports the
 * element selected on the canvas (its source opens in the code view) and hears where the code view's cursor is.
 */
contextBridge.exposeInMainWorld('applingDesktop', {
    selected: (location: { uri: string, start: number, end: number }) => ipcRenderer.send('ideSelected', location),
    onCodeCursor: (callback: (uri: string, offset: number) => void) => ipcRenderer.on('codeCursor', (_event, uri: string, offset: number) => callback(uri, offset))
});

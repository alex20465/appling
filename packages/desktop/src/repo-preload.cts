import { contextBridge, ipcRenderer } from 'electron';

/**
 * The bridge between a repo's IDE view and the main process, for the code view's selection sync: the IDE reports the
 * element selected on the canvas (its source opens in the code view) and hears where the code view's cursor is; the
 * Review tab's text diffs open in the code view's diff editor; an element's code opens there, and the code's CodeLens
 * shows its element on the canvas.
 */
contextBridge.exposeInMainWorld('applingDesktop', {
    // only where the code view runs; elsewhere the Review tab shows the diff itself
    ...(ipcRenderer.sendSync('codeViewSupported') === true ? {
        openTextDiff: (request: { path: string, before?: string, rev: string, line?: number }) => ipcRenderer.send('ideTextDiff', request),
        openCode: (request: { path: string, start: number, end: number }) => ipcRenderer.send('ideOpenCode', request)
    } : {}),
    onCodeElement: (callback: (qn: string) => void) => ipcRenderer.on('codeElement', (_event, qn: string) => callback(qn)),
    selected: (location: { uri: string, start: number, end: number }) => ipcRenderer.send('ideSelected', location),
    onCodeCursor: (callback: (uri: string, offset: number) => void) => ipcRenderer.on('codeCursor', (_event, uri: string, offset: number) => callback(uri, offset))
});

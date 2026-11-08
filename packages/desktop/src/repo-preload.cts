import { contextBridge, ipcRenderer } from 'electron';

/**
 * The bridge between a repo's IDE view and the main process, for the code view's selection sync: the IDE reports the
 * element selected on the canvas (its source opens in the code view) and hears where the code view's cursor is; the
 * Review tab's text diffs open in the code view's diff editor; an element's code opens there, and the code's CodeLens
 * shows its element on the canvas.
 */
// a chapter of another repo asked this view for its Changes tab (#19); held until the client listens
let showChanges: ((session?: string) => void) | undefined;
let pendingChanges: { session?: string } | undefined;
ipcRenderer.on('ideShowChanges', (_event, session?: string) => {
    if (showChanges) showChanges(session);
    else pendingChanges = { session };
});

contextBridge.exposeInMainWorld('applingDesktop', {
    // only where the code view runs; elsewhere the Review tab shows the diff itself
    ...(ipcRenderer.sendSync('codeViewSupported') === true ? {
        openTextDiff: (request: { path: string, before?: string, rev: string, line?: number }) => ipcRenderer.send('ideTextDiff', request),
        openCode: (request: { path: string, start: number, end: number }) => ipcRenderer.send('ideOpenCode', request)
    } : {}),
    onCodeElement: (callback: (qn: string) => void) => ipcRenderer.on('codeElement', (_event, qn: string) => callback(qn)),
    // the playbook (#19) and the claim rings on the canvas jump to an agent session's tab (#10)
    focusSession: (session: string) => ipcRenderer.send('ideFocusSession', session),
    // a chapter's diff in another repo of the workspace: that repo's view shows its Changes tab (#19)
    showChanges: (repo: string, session?: string) => ipcRenderer.send('ideShowChanges', repo, session),
    onShowChanges: (callback: (session?: string) => void) => {
        showChanges = callback;
        if (pendingChanges) callback(pendingChanges.session);
        pendingChanges = undefined;
    },
    selected: (location: { uri: string, start: number, end: number }) => ipcRenderer.send('ideSelected', location),
    onCodeCursor: (callback: (uri: string, offset: number) => void) => ipcRenderer.on('codeCursor', (_event, uri: string, offset: number) => callback(uri, offset)),
    // the workspace of the window the view is in (a repo may sit in several): its playbook plays here (#19)
    workspace: () => ipcRenderer.sendSync('ideWorkspace') as string | undefined,
    onWorkspace: (callback: (workspace: string | undefined) => void) => ipcRenderer.on('ideWorkspace', (_event, workspace?: string) => callback(workspace))
});

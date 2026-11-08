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
    workspaceMenu: (id: string) => ipcRenderer.send('workspaceMenu', id),
    pin: (workspace: string, repo: string, pinned: boolean) => ipcRenderer.send('pin', workspace, repo, pinned),
    reorder: (workspace: string, repo: string, before?: string) => ipcRenderer.send('reorder', workspace, repo, before),
    toggleRail: () => ipcRenderer.send('toggleRail'),
    onSwitcher: (callback: () => void) => ipcRenderer.on('switcher', () => callback()),
    switch: (query: string) => ipcRenderer.invoke('switch', query),
    closeSwitcher: () => ipcRenderer.send('closeSwitcher'),
    addMenu: () => ipcRenderer.send('addMenu'),
    openClone: () => ipcRenderer.send('openClone'),
    move: (repo: string, from: string, to: string) => ipcRenderer.send('move', repo, from, to),
    onClone: (callback: (form: unknown) => void) => ipcRenderer.on('clone', (_event, form) => callback(form)),
    onCloneProgress: (callback: (progress: unknown) => void) => ipcRenderer.on('cloneProgress', (_event, progress) => callback(progress)),
    chooseCloneParent: (current: string) => ipcRenderer.invoke('chooseCloneParent', current),
    clone: (url: string, parent: string, name?: string) => ipcRenderer.invoke('clone', url, parent, name),
    closeClone: () => ipcRenderer.send('closeClone')
});

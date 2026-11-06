import { existsSync, mkdirSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, Menu, shell, WebContentsView, type MenuItemConstructorOptions } from 'electron';
import { EXTENSION, readCodeWorkspace, writeCodeWorkspace } from './code-workspace.js';
import { startIdeProcess, type IdeProcess } from './ide-process.js';
import { COMMANDS, loadKeybindings } from './keybindings.js';
import { Repos } from './repos.js';
import { readSession, restore, sessionOf, writeSession } from './session.js';
import { Workspaces } from './workspaces.js';

/** The width of the rail on the left; every repo view fills the rest of the window. */
const RAIL = 48;
const SHELL = fileURLToPath(new URL('./shell/index.html', import.meta.url));
const PRELOAD = fileURLToPath(new URL('./preload.cjs', import.meta.url));

/** Folders and workspace files handed to this instance on the command line, after `--`, as absolute paths (see `bin.ts`). */
function pathsOf(argv: string[]): string[] {
    const at = argv.indexOf('--');
    return at < 0 ? [] : argv.slice(at + 1);
}

const initial = pathsOf(process.argv);
if (!app.requestSingleInstanceLock({ paths: initial })) {
    // An instance runs already: it receives the paths through `second-instance`.
    app.quit();
} else {
    app.on('second-instance', (_event, argv, _cwd, data) => {
        const paths = (data as { paths?: string[] } | undefined)?.paths ?? pathsOf(argv);
        if (!window) return;
        if (window.isMinimized()) window.restore();
        window.focus();
        openPaths(paths);
    });
    app.whenReady().then(start);
    app.on('window-all-closed', () => app.quit());
    app.on('will-quit', () => {
        for (const process of processes.values()) process.close();
        keybindingsWatcher?.close();
    });
}

const workspaces = new Workspaces();
const repos = new Repos();
const views = new Map<string, WebContentsView>();
const processes = new Map<string, IdeProcess>();
let window: BrowserWindow | undefined;
let keybindingsWatcher: FSWatcher | undefined;

function userFile(...parts: string[]): string {
    return join(app.getPath('userData'), ...parts);
}

/** Where a workspace lives that nobody created explicitly: folders opened without one go there. */
function defaultWorkspace(): string {
    return userFile('workspaces', `Default${EXTENSION}`);
}

function start(): void {
    window = new BrowserWindow({
        width: 1440, height: 900, minWidth: 800, minHeight: 500, title: 'Appling', backgroundColor: '#0c0a08', show: false,
        webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false }
    });
    window.once('ready-to-show', () => window!.show());
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.on('resize', layout);
    window.loadFile(SHELL);

    ipcMain.on('select', (_event, repo: string, workspace?: string) => workspaces.select(repo, workspace) && changed());
    ipcMain.on('selectWorkspace', (_event, id: string) => workspaces.selectWorkspace(id) && changed());
    ipcMain.on('close', (_event, repo: string) => closeRepo(repo));
    ipcMain.on('open', () => addFolderDialog());
    ipcMain.on('newWorkspace', () => newWorkspaceDialog());
    ipcMain.on('retry', (_event, id: string) => retry(id));
    ipcMain.on('repoMenu', (_event, repo: string) => repoMenu(repo));
    ipcMain.on('workspaceMenu', (_event, id: string) => workspaceMenu(id));
    ipcMain.handle('state', () => state());

    watchKeybindings();
    buildMenu();
    const session = readSession(userFile('session.json'));
    const problems = session ? restore(session, workspaces) : [];
    if (problems.length) dialog.showErrorBox('Some workspaces did not reopen', problems.join('\n'));
    openPaths(initial);
    changed();
}

/** Opens workspace files as workspaces and adds folders to the active workspace (the default one when none is open). */
function openPaths(paths: string[]): void {
    for (const path of paths) {
        if (path.endsWith(EXTENSION)) openWorkspace(path);
        else addRepo(path);
    }
    changed();
}

function openWorkspace(file: string): void {
    try {
        workspaces.open(file, existsSync(file) ? readCodeWorkspace(file).folders : []);
        if (!existsSync(file)) writeCodeWorkspace(file, []);
    } catch (error) {
        dialog.showErrorBox(`${basename(file)} did not open`, (error as Error).message);
    }
}

function addRepo(folder: string): void {
    if (!workspaces.current()) openWorkspace(defaultWorkspace());
    const workspace = workspaces.current();
    if (workspace && workspaces.addRepo(workspace.id, folder)) persist(workspace.id);
}

function closeRepo(repo: string): void {
    const workspace = workspaces.current();
    if (workspace && workspaces.removeRepo(workspace.id, repo)) persist(workspace.id);
    changed();
}

/** Writes a workspace's folders back to its file, which keeps its other keys; a file that does not parse is left alone. */
function persist(id: string): void {
    const workspace = workspaces.get(id);
    if (!workspace) return;
    try {
        writeCodeWorkspace(workspace.id, workspace.folders);
    } catch (error) {
        dialog.showErrorBox(`${workspace.name} was not saved`, (error as Error).message);
    }
}

/** After every change: start servers for new repos, stop those that left every workspace, redraw, save the session. */
function changed(): void {
    const live = workspaces.live();
    for (const repo of live) {
        if (repos.add(repo).added) launch(repo);
    }
    for (const repo of repos.all()) {
        if (!live.has(repo.id)) stop(repo.id);
    }
    refresh();
    writeSession(userFile('session.json'), sessionOf(workspaces));
}

async function launch(id: string): Promise<void> {
    repos.update(id, { status: 'starting', error: undefined });
    refresh();
    try {
        const ide = await startIdeProcess(id, {
            node: process.execPath,
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
            onExit: (code, stderr) => {
                if (processes.get(id) !== ide) return;
                processes.delete(id);
                drop(id);
                repos.update(id, { status: 'failed', url: undefined, error: `The IDE server ended with code ${code}.${stderr ? `\n${stderr.trim()}` : ''}` });
                refresh();
            }
        });
        if (!repos.get(id)) return ide.close();
        processes.set(id, ide);
        repos.update(id, { status: 'ready', url: ide.url });
        views.set(id, view(ide.url));
    } catch (error) {
        repos.update(id, { status: 'failed', error: (error as Error).message });
    }
    refresh();
}

function retry(id: string): void {
    const repo = repos.get(id);
    if (repo?.status === 'failed') launch(repo.id);
}

function stop(id: string): void {
    repos.close(id);
    processes.get(id)?.close();
    processes.delete(id);
    drop(id);
}

/** A kept alive view of one repo's IDE: it may only show pages of its own server; links to the web open in the browser. */
function view(url: string): WebContentsView {
    const origin = new URL(url).origin;
    const view = new WebContentsView({ webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
    view.setBackgroundColor('#0c0a08');
    view.webContents.setWindowOpenHandler(({ url: target }) => {
        if (/^https:\/\//.test(target)) shell.openExternal(target);
        return { action: 'deny' };
    });
    view.webContents.on('will-navigate', (event, target) => {
        if (new URL(target).origin !== origin) event.preventDefault();
    });
    view.webContents.loadURL(`${url}/?shell=desktop`);
    window!.contentView.addChildView(view);
    view.setVisible(false);
    return view;
}

function drop(id: string): void {
    const view = views.get(id);
    if (!view) return;
    views.delete(id);
    window?.contentView.removeChildView(view);
    view.webContents.close();
}

async function addFolderDialog(): Promise<void> {
    if (!window) return;
    const result = await dialog.showOpenDialog(window, { title: 'Add a repo to the workspace', properties: ['openDirectory', 'multiSelections'] });
    openPaths(result.filePaths);
}

async function openWorkspaceDialog(): Promise<void> {
    if (!window) return;
    const result = await dialog.showOpenDialog(window, {
        title: 'Open a workspace', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Workspaces', extensions: [EXTENSION.slice(1)] }]
    });
    openPaths(result.filePaths);
}

/** Creates a workspace file (or opens the chosen one when it exists, so a dialog's overwrite never empties a workspace). */
async function newWorkspaceDialog(): Promise<void> {
    if (!window) return;
    mkdirSync(dirname(defaultWorkspace()), { recursive: true });
    const result = await dialog.showSaveDialog(window, {
        title: 'New workspace', buttonLabel: 'Create', defaultPath: userFile('workspaces', `Workspace${EXTENSION}`),
        filters: [{ name: 'Workspaces', extensions: [EXTENSION.slice(1)] }]
    });
    if (result.canceled || !result.filePath) return;
    openPaths([result.filePath.endsWith(EXTENSION) ? result.filePath : `${result.filePath}${EXTENSION}`]);
}

function closeWorkspace(id: string): void {
    workspaces.close(id);
    changed();
}

/** The rail's context menu of a repo: move it to another open workspace, or close it. */
function repoMenu(repo: string): void {
    const from = workspaces.current();
    if (!window || !from) return;
    const others = workspaces.all().filter(w => w.id !== from.id);
    Menu.buildFromTemplate([
        {
            label: 'Move to Workspace', enabled: others.length > 0,
            submenu: others.map(to => ({
                label: to.name,
                click: () => {
                    if (workspaces.moveRepo(repo, from.id, to.id)) [from.id, to.id].forEach(persist);
                    changed();
                }
            }))
        },
        { label: 'Reveal in File Manager', click: () => shell.showItemInFolder(repo) },
        { type: 'separator' },
        { label: 'Close Repo', click: () => closeRepo(repo) }
    ]).popup({ window });
}

function workspaceMenu(id: string): void {
    const workspace = workspaces.get(id);
    if (!window || !workspace) return;
    Menu.buildFromTemplate([
        { label: 'Reveal Workspace File', click: () => shell.showItemInFolder(workspace.id) },
        { type: 'separator' },
        { label: 'Close Workspace', click: () => closeWorkspace(workspace.id) }
    ]).popup({ window });
}

/** Shows the active repo's view over the shell, hides the others (they keep running) and tells the rail. */
function refresh(): void {
    if (!window) return;
    const active = workspaces.activeRepo();
    for (const [id, view] of views) view.setVisible(id === active);
    layout();
    const repo = active ? repos.get(active) : undefined;
    const workspace = workspaces.current();
    window.setTitle([repo?.name, workspace?.name, 'Appling'].filter(Boolean).join(' · '));
    window.webContents.send('state', state());
}

function layout(): void {
    if (!window) return;
    const [width, height] = window.getContentSize();
    for (const view of views.values()) view.setBounds({ x: RAIL, y: 0, width: Math.max(0, width - RAIL), height });
}

function state() {
    return {
        workspaces: workspaces.all().map(w => ({
            id: w.id,
            name: w.name,
            repos: w.folders.map(f => {
                const repo = repos.get(f.path);
                return { id: f.path, name: f.name ?? repo?.name ?? basename(f.path), status: repo?.status ?? 'starting', error: repo?.error };
            })
        })),
        active: workspaces.active,
        repo: workspaces.activeRepo()
    };
}

function activeView(): WebContentsView | undefined {
    const active = workspaces.activeRepo();
    return active ? views.get(active) : undefined;
}

const actions: Record<string, () => void> = {
    open: () => addFolderDialog(),
    closeRepo: () => { const repo = workspaces.activeRepo(); if (repo) closeRepo(repo); },
    nextRepo: () => workspaces.stepRecent(1, Date.now()) && changed(),
    previousRepo: () => workspaces.stepRecent(-1, Date.now()) && changed(),
    ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`repo${i + 1}`, () => workspaces.selectAt(i) && changed()])),
    newWorkspace: () => newWorkspaceDialog(),
    openWorkspace: () => openWorkspaceDialog(),
    closeWorkspace: () => workspaces.active && closeWorkspace(workspaces.active),
    nextWorkspace: () => { workspaces.cycleWorkspace(1); changed(); },
    previousWorkspace: () => { workspaces.cycleWorkspace(-1); changed(); },
    ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`workspace${i + 1}`, () => workspaces.selectWorkspaceAt(i) && changed()])),
    toggleSource: () => activeView()?.webContents.executeJavaScript(`document.querySelector('.bar button[aria-pressed]')?.click()`),
    reload: () => activeView()?.webContents.reload(),
    devTools: () => (activeView()?.webContents ?? window?.webContents)?.toggleDevTools(),
    keybindings: () => {
        const file = keybindingsFile();
        if (!existsSync(file)) writeFileSync(file, '{\n}\n');
        shell.openPath(file);
    },
    quit: () => app.quit()
};

function keybindingsFile(): string {
    return userFile('keybindings.json');
}

/** Rebuilds the menu when the keybindings file changes, so a rebinding applies without a restart. */
function watchKeybindings(): void {
    const file = keybindingsFile();
    mkdirSync(dirname(file), { recursive: true });
    keybindingsWatcher = watch(dirname(file), (_, name) => name === 'keybindings.json' && buildMenu());
}

function buildMenu(): void {
    const { bindings, problems } = loadKeybindings(keybindingsFile());
    if (problems.length) console.error(`Appling Desktop keybindings:\n  ${problems.join('\n  ')}`);
    const item = (command: string): MenuItemConstructorOptions => ({
        label: COMMANDS[command], accelerator: bindings[command] ?? undefined, click: actions[command]
    });
    const numbered = (prefix: string) => Array.from({ length: 9 }, (_, i) => item(`${prefix}${i + 1}`));
    const template: MenuItemConstructorOptions[] = [
        ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
        {
            label: 'File', submenu: [
                item('newWorkspace'), item('openWorkspace'), item('open'), { type: 'separator' },
                item('closeRepo'), item('closeWorkspace'), { type: 'separator' }, item('keybindings'), { type: 'separator' }, item('quit')
            ]
        },
        { role: 'editMenu' },
        { label: 'View', submenu: [item('toggleSource'), item('reload'), item('devTools'), { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
        { label: 'Repo', submenu: [item('nextRepo'), item('previousRepo'), { type: 'separator' }, ...numbered('repo')] },
        { label: 'Workspace', submenu: [item('nextWorkspace'), item('previousWorkspace'), { type: 'separator' }, ...numbered('workspace')] }
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

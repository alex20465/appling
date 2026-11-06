import { existsSync, mkdirSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, Menu, shell, WebContentsView, type MenuItemConstructorOptions } from 'electron';
import { startIdeProcess, type IdeProcess } from './ide-process.js';
import { COMMANDS, loadKeybindings } from './keybindings.js';
import { Repos } from './repos.js';

/** The width of the repo rail on the left; every repo view fills the rest of the window. */
const RAIL = 64;
const SHELL = fileURLToPath(new URL('./shell/index.html', import.meta.url));
const PRELOAD = fileURLToPath(new URL('./preload.cjs', import.meta.url));

/** Folders handed to this instance on the command line, after `--`, as absolute paths (see `bin.ts`). */
function foldersOf(argv: string[]): string[] {
    const at = argv.indexOf('--');
    return at < 0 ? [] : argv.slice(at + 1);
}

const initial = foldersOf(process.argv);
if (!app.requestSingleInstanceLock({ folders: initial })) {
    // An instance runs already: it receives the folders through `second-instance`.
    app.quit();
} else {
    app.on('second-instance', (_event, argv, _cwd, data) => {
        const folders = (data as { folders?: string[] } | undefined)?.folders ?? foldersOf(argv);
        if (!window) return;
        if (window.isMinimized()) window.restore();
        window.focus();
        folders.forEach(open);
    });
    app.whenReady().then(start);
    app.on('window-all-closed', () => app.quit());
    app.on('will-quit', () => {
        for (const process of processes.values()) process.close();
        keybindingsWatcher?.close();
    });
}

const repos = new Repos();
const views = new Map<string, WebContentsView>();
const processes = new Map<string, IdeProcess>();
let window: BrowserWindow | undefined;
let keybindingsWatcher: FSWatcher | undefined;

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

    ipcMain.on('select', (_event, id: string) => repos.select(id) && refresh());
    ipcMain.on('close', (_event, id: string) => close(id));
    ipcMain.on('open', () => openDialog());
    ipcMain.on('retry', (_event, id: string) => retry(id));
    ipcMain.handle('state', () => state());

    watchKeybindings();
    buildMenu();
    initial.forEach(open);
}

/** Opens a folder, or activates it when it is open already; its IDE server and view start in the background. */
function open(folder: string): void {
    const { repo, added } = repos.add(folder);
    refresh();
    if (added) launch(repo.id);
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
    if (repo?.status === 'failed') launch(id);
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

function close(id: string): void {
    if (!repos.close(id)) return;
    processes.get(id)?.close();
    processes.delete(id);
    drop(id);
    refresh();
}

async function openDialog(): Promise<void> {
    if (!window) return;
    const result = await dialog.showOpenDialog(window, { title: 'Open a repo', properties: ['openDirectory', 'multiSelections'] });
    result.filePaths.forEach(open);
}

/** Shows the active repo's view over the shell, hides the others (they keep running) and tells the rail. */
function refresh(): void {
    if (!window) return;
    for (const [id, view] of views) view.setVisible(id === repos.active);
    layout();
    const active = repos.active && repos.get(repos.active);
    window.setTitle(active ? `${active.name} · Appling` : 'Appling');
    window.webContents.send('state', state());
}

function layout(): void {
    if (!window) return;
    const [width, height] = window.getContentSize();
    for (const view of views.values()) view.setBounds({ x: RAIL, y: 0, width: Math.max(0, width - RAIL), height });
}

function state() {
    return { repos: repos.all(), active: repos.active };
}

function activeView(): WebContentsView | undefined {
    return repos.active ? views.get(repos.active) : undefined;
}

const actions: Record<string, () => void> = {
    open: () => openDialog(),
    closeRepo: () => repos.active && close(repos.active),
    nextRepo: () => { repos.cycle(1); refresh(); },
    previousRepo: () => { repos.cycle(-1); refresh(); },
    ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`repo${i + 1}`, () => repos.selectAt(i) && refresh()])),
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
    return join(app.getPath('userData'), 'keybindings.json');
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
    const template: MenuItemConstructorOptions[] = [
        ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
        { label: 'File', submenu: [item('open'), item('closeRepo'), { type: 'separator' }, item('keybindings'), { type: 'separator' }, item('quit')] },
        { role: 'editMenu' },
        { label: 'View', submenu: [item('toggleSource'), item('reload'), item('devTools'), { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
        { label: 'Repo', submenu: [item('nextRepo'), item('previousRepo'), { type: 'separator' }, ...Array.from({ length: 9 }, (_, i) => item(`repo${i + 1}`))] }
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

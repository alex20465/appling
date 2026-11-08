import { existsSync, mkdirSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, dialog, ipcMain, Menu, screen, shell, WebContentsView, type IpcMainEvent, type MenuItemConstructorOptions, type WebContents } from 'electron';
import type { TextDiffRequest } from './code-bridge.js';
import { CodeViews, type SourceLocation } from './code-view.js';
import { EXTENSION, readCodeWorkspace, writeCodeWorkspace } from './code-workspace.js';
import { displayFingerprint, displayOf, placeWindow, type DisplayInfo } from './displays.js';
import { gitBranch, watchGit } from './git.js';
import { agentSessions, desktopHost } from './agent-sessions.js';
import { appCommand, sessionArg, trayMode, withoutAppFlags } from './app-flags.js';
import { cloneIpc } from './clone-ipc.js';
import { agentContributions, RailStatus, railBadge, railLines } from './rail-status.js';
import { desktopPlaybooks, playbookRail } from './playbooks.js';
import { startIdeProcess, type IdeProcess } from './ide-process.js';
import { COMMANDS, loadKeybindings } from './keybindings.js';
import { IDE_PANE, paneId, paneLabel, parsePane, registerPaneType } from './panes.js';
import { Repos } from './repos.js';
import { readSession, restore, sessionOf, writeSession } from './session.js';
import { switcherEntries } from './switcher.js';
import { appLaunch, codeViewOpener, TERMINAL_PANE, TerminalPanel } from './terminal/panel.js';
import { startTray } from './tray.js';
import { Updater } from './updater.js';
import { currentDisplays, WindowHost } from './window-host.js';
import { dropTarget, layoutFor, MAIN, rememberLayout, type SavedLayout } from './windows.js';
import { Workspaces } from './workspaces.js';
import { systemNotifier } from '@appling/pty-host';
import { RemoteRepos } from './remote/desktop.js';
import { RemoteStatus } from './remote/notify.js';
import { findDevcontainer } from './remote/devcontainer.js';
import { serverBundle } from './remote/install.js';
import { isRemoteId } from './remote/location.js';
import { remoteIpc } from './remote/remote-ipc.js';

/** The width of the rail on the left (none while it is collapsed); every repo view fills the rest of the window. */
const RAIL = 48;
const SHELL = fileURLToPath(new URL('./shell/index.html', import.meta.url));
const PRELOAD = fileURLToPath(new URL('./preload.cjs', import.meta.url));
const REPO_PRELOAD = fileURLToPath(new URL('./repo-preload.cjs', import.meta.url));
/** The code view's pane type (#8): a strip on the right of the repo's column, or a column of its own when moved. */
const CODE_PANE = 'code';

/**
 * Folders and workspace files handed to this instance on the command line, after `--`, as absolute paths (see `bin.ts`);
 * the packaged app also takes them without `--` (`Appling.AppImage shop`), relative to the current folder.
 */
function pathsOf(argv: string[]): string[] {
    argv = withoutAppFlags(argv);
    const at = argv.indexOf('--');
    if (at >= 0) return argv.slice(at + 1);
    return app.isPackaged ? argv.slice(1).filter(arg => !arg.startsWith('-')).map(arg => isRemoteId(arg) ? arg : resolve(arg)) : [];
}

const initial = pathsOf(process.argv);
/** `--session <terminal>`: open at that terminal of the pty host, as a click on its notification asks (issue #18). */
const initialSession = sessionArg(process.argv);
// `--version` prints and quits before any window, so it runs without a display (the release check uses it).
if (process.argv.slice(0, process.argv.includes('--') ? process.argv.indexOf('--') : undefined).includes('--version')) {
    console.log(app.getVersion());
    app.exit(0);
} else if (trayMode(process.argv)) {
    // the tray only mode: a process of its own (own profile, own lock) that holds no windows and no terminals
    app.setPath('userData', join(app.getPath('appData'), 'Appling Tray'));
    app.whenReady().then(() => startTray({ icon: fileURLToPath(new URL('./tray-icon.png', import.meta.url)), command: args => appCommand(appLaunch(), args) }));
} else if (!app.requestSingleInstanceLock({ paths: initial, session: initialSession })) {
    // An instance runs already: it receives the paths through `second-instance`.
    app.quit();
} else {
    app.on('second-instance', (_event, argv, _cwd, data) => {
        const paths = (data as { paths?: string[] } | undefined)?.paths ?? pathsOf(argv);
        host.show(windows.focused().id);
        openPaths(paths);
        const session = (data as { session?: string } | undefined)?.session ?? sessionArg(argv);
        if (session) void openSession(session);
    });
    app.whenReady().then(start);
    app.on('window-all-closed', () => app.quit());
    // the layout is saved before the windows close, so closing them on the way out changes nothing
    app.on('before-quit', () => {
        save();
        quitting = true;
    });
    app.on('will-quit', () => {
        for (const process of processes.values()) process.close();
        for (const unwatch of heads.values()) unwatch();
        keybindingsWatcher?.close();
        code?.close();
        remotes.killAll();
        remoteStatus.close();
    });
}

const workspaces = new Workspaces();
const repos = new Repos();
const processes = new Map<string, IdeProcess>();
/** The agent sessions of every workspace, shared by the repo servers (issue #16). */
const sessions = agentSessions();
/** What the rail shows per repo and per workspace; every feature reports into its own source (`rail-status.ts`). */
const rail = new RailStatus();
const railSources = { validation: rail.source('validation'), editor: rail.source('editor'), git: rail.source('git'), agents: rail.source('agents'), live: rail.source('live'), playbook: rail.source('playbook'), connection: rail.source('connection') };
/** Repos on SSH hosts, in dev containers and in WSL (`remote/`): their servers run there, reached over the transport. */
/** Notifications here for the terminals of remote repos that need input while no view is attached (#18). */
const remoteStatus = new RemoteStatus({
    notifier: systemNotifier(),
    open: repo => {
        host.show(windows.focused().id);
        if (workspaces.select(repo)) changed();
    },
    log: message => console.error(message)
});
const remotes = new RemoteRepos({ userData: app.getPath('userData'), app: () => serverBundle(), rail: { connection: railSources.connection, git: railSources.git } });
sessions.onChange(list => railSources.agents.replace(agentContributions(list)));
rail.onChange(() => refresh());
/** The playbook of every workspace (#19), kept in the app's data folder; unwatched chapters count on the rail. */
const playbooks = desktopPlaybooks(join(app.getPath('userData'), 'playbooks'));
const playbookCounts = playbookRail(playbooks, railSources.playbook, key => !!workspaces.get(key) || workspaces.live().has(key));
/** Watchers of each repo's git `HEAD`, so the rail follows checkouts made anywhere. */
const heads = new Map<string, () => void>();
const updater = new Updater(() => host.base());
let keybindingsWatcher: FSWatcher | undefined;
/** The code view (Code OSS) of every repo. */
let code: CodeViews | undefined;
/** The window whose shell page draws the clone form; its panes are covered meanwhile. */
let cloneWindow: string | undefined;
const openClone = cloneIpc({
    window: () => host.base(cloneWindow),
    shell: () => cloneWindow ? host.native(cloneWindow)?.shell.webContents : undefined,
    folders: () => workspaces.current()?.folders.map(f => f.path) ?? [],
    shown: open => {
        if (open) cloneWindow = windows.focused().id;
        if (cloneWindow) host.cover(cloneWindow, 'clone', open);
        refresh();
        if (!open) activeView()?.webContents.focus();
    },
    add: folder => openPaths([folder])
});
/** The window whose shell page draws the remote repo form. */
let remoteWindow: string | undefined;
const remoteForm = remoteIpc({
    window: () => host.base(remoteWindow),
    shell: () => remoteWindow ? host.native(remoteWindow)?.shell.webContents : undefined,
    shown: open => {
        if (open) remoteWindow = windows.focused().id;
        if (remoteWindow) host.cover(remoteWindow, 'remote', open);
        refresh();
        if (!open) activeView()?.webContents.focus();
    },
    add: id => openPaths([id])
});
/**
 * The windows (issue #14). Every window has the rail and the switcher; the panes (each repo's view first) move
 * between them without reloading. While a window's switcher is open its panes are hidden, so the shell page is on top.
 */
const host = new WindowHost({
    shell: SHELL, preload: PRELOAD,
    rail: () => workspaces.collapsed ? 0 : RAIL,
    shown: id => workspaces.get(windows.activeOf(id, openIds()) ?? '')?.active,
    onFocus: id => focusWindow(id),
    onClosed: () => changed(),
    onMainClosed: () => app.quit(),
    onMoved: () => saveSoon(),
    quitting: () => quitting
});
const windows = host.windows;
/** The terminal panel of each repo (`terminal/`), a `terminal` pane under its canvas. */
const terminals = new TerminalPanel({
    userData: app.getPath('userData'),
    activeRepo: () => workspaces.activeRepo(),
    workspaceFiles: repo => workspaces.all().filter(w => w.folders.some(f => f.path === repo)).map(w => w.id),
    runCommand: command => actions[command]?.(),
    attach: (repo, view) => host.addPane(paneId(TERMINAL_PANE, repo), view),
    detach: repo => host.removePane(paneId(TERMINAL_PANE, repo)),
    setHidden: (repo, hidden) => host.setHidden(paneId(TERMINAL_PANE, repo), hidden),
    refresh: () => refresh(),
    focusRepoView: repo => host.panes.get(paneId(IDE_PANE, repo))?.webContents.focus(),
    window: () => host.base()
});
/** The window layouts per monitor setup, as the session holds them. */
let layouts: Record<string, SavedLayout> = {};
/** The displays at the last change, to place windows whose display is gone where they were. */
let displays: DisplayInfo[] = [];
/** The workspace and repo shown at the last change, to reveal their window when they change. */
let lastShown = '';
let saveTimer: NodeJS.Timeout | undefined;
let quitting = false;

function userFile(...parts: string[]): string {
    return join(app.getPath('userData'), ...parts);
}

/** Where a workspace lives that nobody created explicitly: folders opened without one go there. */
function defaultWorkspace(): string {
    return userFile('workspaces', `Default${EXTENSION}`);
}

function start(): void {
    code = new CodeViews({
        userData: app.getPath('userData'),
        attach: (repo, view) => host.addPane(paneId(CODE_PANE, repo), view),
        detach: repo => host.removePane(paneId(CODE_PANE, repo)),
        ideView: repo => host.panes.get(paneId(IDE_PANE, repo)),
        onChange: () => refresh(),
        remote: repo => {
            const remote = remotes.get(repo);
            return remote?.root ? { folder: remote.root, start: key => remote.startCode(key) } : undefined;
        }
    });
    registerPaneType({ type: CODE_PANE, label: 'Code', region: 'side', share: code.settings.width });
    terminals.start();
    // file paths in terminals open in the repo's code view where there is one, else in the OS
    if (CodeViews.supported()) terminals.fileOpener = codeViewOpener(code);
    /** Every message from a shell page acts in the window that sent it, which becomes the focused one. */
    const on = (channel: string, listener: (window: string, ...args: any[]) => void) =>
        ipcMain.on(channel, (event: IpcMainEvent, ...args: any[]) => {
            const window = host.idOf(event.sender);
            if (window) listener(enter(window), ...args);
        });
    on('select', (window, repo: string, workspace?: string) => {
        const selected = workspaces.select(repo, workspace);
        closeSwitcher(window);
        if (selected) changed();
    });
    on('selectWorkspace', (_window, id: string) => workspaces.selectWorkspace(id) && changed());
    on('close', (_window, repo: string) => closeRepo(repo));
    on('open', () => addFolderDialog());
    on('addMenu', window => addMenu(window));
    on('openClone', () => openClone());
    on('openRemote', () => remoteForm.open());
    on('move', (_window, repo: string, from: string, to: string) => moveRepo(repo, from, to));
    on('newWorkspace', () => newWorkspaceDialog());
    on('retry', (_window, id: string) => retry(id));
    on('repoMenu', (window, repo: string) => repoMenu(window, repo));
    on('workspaceMenu', (window, id: string) => workspaceMenu(window, id));
    on('paneMenu', (window, pane: string) => paneMenu(window, pane));
    on('pin', (_window, workspace: string, repo: string, pinned: boolean) => workspaces.pin(workspace, repo, pinned) && changed());
    on('hide', (_window, workspace: string, repo: string, hidden: boolean) => workspaces.hide(workspace, repo, hidden) && changed());
    on('reorder', (_window, workspace: string, repo: string, before?: string) => {
        if (workspaces.reorder(workspace, repo, before)) persist(workspace);
        changed();
    });
    on('toggleRail', () => toggleRail());
    on('closeSwitcher', window => closeSwitcher(window));
    on('detach', (window, kind: DragKind, id: string, x: number, y: number) => detach(window, kind, id, { x, y }));
    on('drop', (window, kind: DragKind, id: string) => moveTo(kind, id, window));
    on('focusPane', (_window, pane: string) => focusPane(pane));
    on('dockPane', (_window, pane: string) => windows.dockPane(pane) && changed());
    ipcMain.handle('switch', (_event, query: string) => switcherEntries(workspaces, repoName, typeof query === 'string' ? query : ''));
    ipcMain.handle('state', event => state(host.idOf(event.sender) ?? MAIN));
    ipcMain.on('codeViewSupported', event => event.returnValue = CodeViews.supported());
    const repoOf = (sender: WebContents) => {
        const pane = [...host.panes].find(([id, view]) => view.webContents === sender && parsePane(id)?.type === IDE_PANE)?.[0];
        return pane ? parsePane(pane)?.repo : undefined;
    };
    ipcMain.on('ideSelected', (event, location: SourceLocation) => {
        const repo = repoOf(event.sender);
        if (repo && typeof location?.uri === 'string' && Number.isInteger(location.start)) code?.selected(repo, location);
    });
    ipcMain.on('ideTextDiff', (event, request: TextDiffRequest) => {
        const repo = repoOf(event.sender);
        if (repo) code?.textDiff(repo, request);
    });

    watchKeybindings();
    buildMenu();
    const session = readSession(userFile('session.json'));
    const problems = session ? restore(session, workspaces) : [];
    layouts = session?.layouts ?? {};
    displays = currentDisplays();
    const layout = layoutFor(layouts, displays);
    if (layout) {
        windows.restore(layout, openIds(), workspaces.live());
        placeWindows(layout.displays);
    }
    screen.on('display-added', () => displaysChanged());
    screen.on('display-removed', () => displaysChanged());
    screen.on('display-metrics-changed', () => displaysChanged());
    if (problems.length) dialog.showErrorBox('Some workspaces did not reopen', problems.join('\n'));
    openPaths(initial);
    changed();
    if (initialSession) void openSession(initialSession);
    updater.start();
}

/** Shows a terminal of the pty host: adds its repo when no workspace has it, selects the repo and opens its tab. */
async function openSession(terminal: string): Promise<void> {
    try {
        const repo = await terminals.repoOfTerminal(terminal);
        if (!repo) return;
        if (!workspaces.all().some(w => w.folders.some(f => f.path === repo))) openPaths([repo]);
        if (workspaces.select(repo)) changed();
        await terminals.reveal(repo, terminal);
    } catch (error) {
        console.error(`The session ${terminal} did not open: ${(error as Error).message}`);
    }
}

/** Opens workspace files as workspaces and adds folders to the active workspace (the default one when none is open). */
function openPaths(paths: string[]): void {
    for (const path of paths) {
        if (path.endsWith(EXTENSION)) openWorkspace(path);
        else addRepo(path);
    }
    changed();
}

/** Opens a workspace in the focused window (an open one is only shown, in its window). */
function openWorkspace(file: string): void {
    try {
        const { workspace, added } = workspaces.open(file, existsSync(file) ? readCodeWorkspace(file).folders : []);
        if (added && windows.focused().id !== MAIN) windows.moveWorkspace(workspace.id, windows.focused().id);
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

/**
 * After every change: start servers for new repos, stop those that left every workspace, close the windows left
 * empty, show the window of a newly shown workspace or repo, redraw, save the session.
 */
function changed(): void {
    const live = workspaces.live();
    for (const repo of live) {
        if (repos.add(repo).added) {
            watchBranch(repo);
            launch(repo);
            terminals.openRepo(repo);
        }
    }
    for (const repo of repos.all()) {
        if (!live.has(repo.id)) stop(repo.id);
    }
    code?.sync(live);
    windows.prune(openIds(), live);
    const shown = shownKey();
    const revealed = shown !== lastShown ? reveal() : undefined;
    lastShown = shown;
    playbookCounts.refresh();
    refresh();
    if (revealed) host.show(revealed);
    save();
}

async function launch(id: string): Promise<void> {
    if (isRemoteId(id)) return launchRemote(id);
    repos.update(id, { status: 'starting', error: undefined });
    refresh();
    try {
        const ide = await startIdeProcess(id, {
            node: process.execPath,
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
            sessions,
            playbooks,
            host: desktopHost(workspaces),
            onStatus: ({ errors, unsaved, changes }) => {
                if (processes.get(id) !== ide && processes.has(id)) return;
                if (errors !== undefined) railSources.validation.set(id, { counts: { errors } });
                if (changes !== undefined) railSources.live.set(id, { counts: { unseen: changes } });
                if (unsaved) railSources.editor.set(id, { counts: { unsaved: unsaved.length }, notes: unsaved.map(f => `Unsaved: ${f}`) });
            },
            onExit: (code, stderr) => {
                if (processes.get(id) !== ide) return;
                processes.delete(id);
                drop(id);
                railSources.validation.clear(id);
                railSources.editor.clear(id);
                railSources.live.clear(id);
                repos.update(id, { status: 'failed', url: undefined, error: `The IDE server ended with code ${code}.${stderr ? `\n${stderr.trim()}` : ''}` });
                refresh();
            }
        });
        if (!repos.get(id)) return ide.close();
        processes.set(id, ide);
        repos.update(id, { status: 'ready', url: ide.url });
        host.addPane(paneId(IDE_PANE, id), view(ide.url));
    } catch (error) {
        repos.update(id, { status: 'failed', error: (error as Error).message });
    }
    refresh();
}

/** A repo on another machine: connects, installs and starts its server there; the view keeps its URL across reconnects. */
async function launchRemote(id: string): Promise<void> {
    repos.update(id, { status: 'starting', error: undefined });
    refresh();
    try {
        await remotes.launch(id, {
            ide: {
                sessions,
                playbooks,
                host: desktopHost(workspaces),
                onStatus: ({ errors, unsaved, changes }) => {
                    if (errors !== undefined) railSources.validation.set(id, { counts: { errors } });
                    if (changes !== undefined) railSources.live.set(id, { counts: { unseen: changes } });
                    if (unsaved) railSources.editor.set(id, { counts: { unsaved: unsaved.length }, notes: unsaved.map(f => `Unsaved: ${f}`) });
                }
            },
            onConnected: (url, ide, again) => {
                if (!repos.get(id)) return;
                processes.set(id, ide);
                repos.update(id, { status: 'ready', url, error: undefined });
                if (!remotes.get(id)?.terminalsProblem) remoteStatus.watch(id, remotes.ptyDir(id)).catch(error => console.error(`The terminal status of ${id} is not followed: ${(error as Error).message}`));
                const existing = host.panes.get(paneId(IDE_PANE, id));
                if (!existing) host.addPane(paneId(IDE_PANE, id), view(url));
                else if (again) existing.webContents.reload();
                refresh();
            },
            onFailed: error => {
                processes.delete(id);
                drop(id);
                railSources.validation.clear(id);
                railSources.editor.clear(id);
                railSources.live.clear(id);
                repos.update(id, { status: 'failed', url: undefined, error });
                refresh();
            }
        });
    } catch (error) {
        repos.update(id, { status: 'failed', error: (error as Error).message });
    }
    refresh();
}

function retry(id: string): void {
    const repo = repos.get(id);
    if (repo?.status === 'failed') launch(repo.id);
}

/** Follows a repo's branch, ahead and behind counts and dirty state for the rail (see `watchGit`). */
function watchBranch(id: string): void {
    // remote repos: `RemoteRepos` reads the git state over the transport
    if (isRemoteId(id)) return;
    railSources.git.set(id, { branch: gitBranch(id) });
    heads.set(id, watchGit(id, state => {
        if (!repos.get(id)) return;
        railSources.git.set(id, { branch: state.branch, git: { upstream: state.upstream, ahead: state.ahead, behind: state.behind, dirty: state.dirty } });
    }));
}

function stop(id: string): void {
    repos.close(id);
    rail.clear(undefined, id);
    heads.get(id)?.();
    heads.delete(id);
    processes.get(id)?.close();
    processes.delete(id);
    if (isRemoteId(id)) {
        remoteStatus.unwatch(id);
        void remotes.stop(id);
    }
    drop(id);
    terminals.closeRepo(id);
}

/** A kept alive view of one repo's IDE: it may only show pages of its own server; links to the web open in the browser. */
function view(url: string): WebContentsView {
    const origin = new URL(url).origin;
    const view = new WebContentsView({ webPreferences: { preload: REPO_PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false } });
    view.setBackgroundColor('#0c0a08');
    view.webContents.setWindowOpenHandler(({ url: target }) => {
        if (/^https:\/\//.test(target)) shell.openExternal(target);
        return { action: 'deny' };
    });
    view.webContents.on('will-navigate', (event, target) => {
        if (new URL(target).origin !== origin) event.preventDefault();
    });
    view.webContents.loadURL(`${url}/?shell=desktop`);
    view.setVisible(false);
    return view;
}

function drop(id: string): void {
    host.removePane(paneId(IDE_PANE, id))?.webContents.close();
}

async function addFolderDialog(): Promise<void> {
    const window = host.base();
    if (!window) return;
    const result = await dialog.showOpenDialog(window, { title: 'Add a repo to the workspace', properties: ['openDirectory', 'multiSelections'] });
    openPaths(result.filePaths);
}

async function openWorkspaceDialog(): Promise<void> {
    const window = host.base();
    if (!window) return;
    const result = await dialog.showOpenDialog(window, {
        title: 'Open a workspace', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Workspaces', extensions: [EXTENSION.slice(1)] }]
    });
    openPaths(result.filePaths);
}

/** Creates a workspace file (or opens the chosen one when it exists, so a dialog's overwrite never empties a workspace). */
async function newWorkspaceDialog(): Promise<void> {
    const window = host.base();
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

/** The rail's context menu of a repo: move it to another open workspace or window, or close it. */
function repoMenu(window: string, repo: string): void {
    const from = workspaces.current();
    const base = host.base(window);
    if (!base || !from) return;
    const others = workspaces.all().filter(w => w.id !== from.id);
    const pinned = from.pinned.includes(repo);
    const away = windows.windowOfPane(paneId(IDE_PANE, repo));
    Menu.buildFromTemplate([
        { label: pinned ? 'Unpin' : 'Pin to Top', click: () => workspaces.pin(from.id, repo, !pinned) && changed() },
        { label: 'Hide from Rail', click: () => workspaces.hide(from.id, repo, true) && changed() },
        { type: 'separator' },
        {
            label: 'Move to Workspace', enabled: others.length > 0,
            submenu: others.map(to => ({ label: to.name, click: () => moveRepo(repo, from.id, to.id) }))
        },
        ...moveItems('repo', repo, window),
        ...(away ? [{ label: `Dock Back from ${windowName(away.id)}`, click: () => windows.dockPane(paneId(IDE_PANE, repo)) && changed() }] : []),
        ...paneItems(repo, window),
        { label: 'Reveal in File Manager', enabled: !isRemoteId(repo), click: () => shell.showItemInFolder(repo) },
        ...!isRemoteId(repo) && findDevcontainer(repo) ? [{ label: 'Reopen in Dev Container', click: () => remoteForm.openContainer(repo) }] : [],
        { label: 'Open in VS Code', click: () => code?.openInVSCode(repo, false) },
        { type: 'separator' },
        { label: 'Close Repo', click: () => closeRepo(repo) }
    ]).popup({ window: base });
}

/** Moves a repo to another workspace (rail menu, or a repo dropped on a workspace) and writes both workspace files. */
function moveRepo(repo: string, from: string, to: string): void {
    if (workspaces.moveRepo(repo, from, to)) [from, to].forEach(persist);
    changed();
}

/** The `+` below the repos: add a folder or clone a repository. */
function addMenu(window: string): void {
    const base = host.base(window);
    if (!base) return;
    Menu.buildFromTemplate([
        { label: 'Add Folder…', click: () => addFolderDialog() },
        { label: 'Clone Repository…', click: () => openClone() },
        { label: 'Add Remote Repository…', click: () => remoteForm.open() },
        { label: 'Open Folder in Dev Container…', click: () => remoteForm.openContainer() }
    ]).popup({ window: base });
}

function workspaceMenu(window: string, id: string): void {
    const workspace = workspaces.get(id);
    const base = host.base(window);
    if (!base || !workspace) return;
    Menu.buildFromTemplate([
        {
            label: 'Hidden Repos', enabled: workspace.hidden.length > 0,
            submenu: workspace.hidden.map(repo => ({ label: `Show ${repoName(repo, workspace.folders.find(f => f.path === repo)?.name)}`, click: () => workspaces.hide(workspace.id, repo, false) && changed() }))
        },
        { type: 'separator' },
        ...moveItems('workspace', workspace.id, window),
        { type: 'separator' },
        { label: 'Reveal Workspace File', click: () => shell.showItemInFolder(workspace.id) },
        { type: 'separator' },
        { label: 'Close Workspace', click: () => closeWorkspace(workspace.id) }
    ]).popup({ window: base });
}

/** The context menu of a pane moved into a window: send it back to its repo, or on to another window. */
function paneMenu(window: string, pane: string): void {
    const base = host.base(window);
    if (!base || !parsePane(pane)) return;
    Menu.buildFromTemplate([
        { label: 'Dock Back', click: () => windows.dockPane(pane) && changed() },
        ...moveItems('pane', pane, window)
    ]).popup({ window: base });
}

/** Shows each window's repo and panes (the others keep running hidden) and tells every rail. */
function refresh(): void {
    // a closed code view stays alive, hidden; the canvas then fills the repo's column
    for (const pane of host.panes.keys()) {
        const ref = parsePane(pane);
        if (ref?.type === CODE_PANE) host.setHidden(pane, !code?.isShown(ref.repo));
    }
    host.arrange();
    code?.visible(new Set(windows.all().flatMap(w => {
        const repo = workspaces.get(windows.activeOf(w.id, openIds()) ?? '')?.active;
        return [...(repo ? [repo] : []), ...w.panes.flatMap(p => parsePane(p)?.type === CODE_PANE ? [parsePane(p)!.repo] : [])];
    })));
    for (const [id] of host.shells()) {
        const shown = state(id);
        const repo = shown.repo ? repos.get(shown.repo) : undefined;
        const workspace = shown.active ? workspaces.get(shown.active) : undefined;
        const panes = shown.panes.map(p => `${p.name} · ${p.label}`);
        host.base(id)?.setTitle([repo?.name, workspace?.name, ...(repo || workspace ? [] : panes), 'Appling'].filter(Boolean).join(' · '));
        host.send(id, 'state', shown);
    }
}

/** A repo's name in the rail and the switcher: the workspace file's display name, else the folder's name. */
function repoName(path: string, folderName?: string): string {
    return folderName ?? repos.get(path)?.name ?? (basename(path) || path);
}

/** What a window's rail shows: the workspaces it holds, the repos of its shown one, and the panes moved into it. */
function state(window: string) {
    const open = openIds();
    const active = windows.activeOf(window, open);
    const current = active ? workspaces.get(active) : undefined;
    // the shown repo stays on the rail while it is hidden, so you can see where you are
    const shownHidden = current?.active && current.hidden.includes(current.active) ? current.active : undefined;
    const away = (repo: string) => {
        const pane = paneId(IDE_PANE, repo);
        const moved = windows.windowOfPane(pane);
        return moved && moved.id !== window ? { window: windowName(moved.id), pane } : undefined;
    };
    return {
        window: { id: window, name: windowName(window), main: window === MAIN, count: windows.all().length },
        workspaces: windows.workspacesOf(window, open).map(id => workspaces.get(id)!).map(w => ({
            id: w.id,
            name: w.name,
            hidden: w.hidden.length,
            // summed over every repo of the workspace, hidden ones included
            ...railView({ counts: rail.sum(w.folders.map(f => f.path)) }),
            repos: w.folders.filter(f => workspaces.rail(w.id).includes(f) || (w === current && f.path === shownHidden))
                .sort((a, b) => Number(!w.pinned.includes(a.path)) - Number(!w.pinned.includes(b.path)))
                .map(f => {
                    const repo = repos.get(f.path);
                    return {
                        id: f.path, name: repoName(f.path, f.name), status: repo?.status ?? 'starting', error: repo?.error,
                        ...railView(rail.repo(f.path)),
                        pinned: w.pinned.includes(f.path), hidden: w.hidden.includes(f.path), away: away(f.path)
                    };
                })
        })),
        // other workspaces live in other windows: the rail counts them, the switcher still finds them
        elsewhere: open.length - windows.workspacesOf(window, open).length,
        panes: (windows.get(window)?.panes ?? []).map(pane => {
            const ref = parsePane(pane)!;
            const repo = repos.get(ref.repo);
            return { id: pane, repo: ref.repo, name: repoName(ref.repo), label: paneLabel(pane), status: repo?.status ?? 'starting', ...railView(rail.repo(ref.repo)) };
        }),
        active,
        repo: current?.active,
        collapsed: workspaces.collapsed
    };
}

/** A rail button's status for the shell: the counts, the badge (the most urgent count) and the tooltip lines. */
function railView(status: Parameters<typeof railLines>[0]) {
    return { counts: status.counts, branch: status.branch, git: status.git, connection: (status as { connection?: string }).connection, badge: railBadge(status.counts), lines: railLines(status) };
}

function toggleRail(): void {
    workspaces.collapsed = !workspaces.collapsed;
    changed();
}

/** Opens the switcher over the focused window's shell page; the shell asks for its lines through `switch` and picks with `select`. */
function openSwitcher(): void {
    const window = windows.focused().id;
    if (!host.cover(window, 'switcher', true)) return;
    refresh();
    host.native(window)?.shell.webContents.focus();
    host.send(window, 'switcher');
}

function closeSwitcher(window: string = windows.focused().id): void {
    if (!host.cover(window, 'switcher', false)) return;
    refresh();
    activeView()?.webContents.focus();
}

/** The view the focused window shows: its repo's canvas, else the first pane moved into it. */
function activeView(): WebContentsView | undefined {
    const window = windows.focused().id;
    const repo = workspaces.get(windows.activeOf(window, openIds()) ?? '')?.active;
    const canvas = repo ? paneId(IDE_PANE, repo) : undefined;
    const pane = canvas && host.paneWindow(canvas) === window ? canvas : windows.focused().panes.find(p => host.panes.has(p));
    return pane ? host.panes.get(pane) : undefined;
}

// ---- windows (issue #14) ----

/** The open workspace ids in rail order. */
function openIds(): string[] {
    return workspaces.all().map(w => w.id);
}

function shownKey(): string {
    return `${workspaces.active}\n${workspaces.activeRepo()}`;
}

/** Acting in a window makes its workspace the active one, so every command (and the switcher) works on it. */
function enter(window: string): string {
    windows.focus(window);
    const active = windows.activeOf(window, openIds());
    if (active && active !== workspaces.active) workspaces.selectWorkspace(active);
    lastShown = shownKey();
    return window;
}

/** A window got the focus from the system: its workspace becomes the active one. */
function focusWindow(window: string): void {
    if (!windows.get(window)) return;
    const before = shownKey();
    enter(window);
    if (shownKey() !== before) refresh();
}

/**
 * After the shown workspace or repo changed (through a shortcut, the switcher or another window's rail): the window
 * holding it shows it and gets the focus, or the window the repo's canvas was moved to.
 */
function reveal(): string | undefined {
    if (!workspaces.active) return undefined;
    const owner = windows.follow(workspaces.active);
    const repo = workspaces.activeRepo();
    const target = (repo ? windows.windowOfPane(paneId(IDE_PANE, repo)) : undefined) ?? owner;
    windows.focus(target.id);
    return target.id;
}

/** Places the windows on the displays there are now; those whose display is gone go to the primary one. */
function placeWindows(before: readonly DisplayInfo[]): void {
    const now = currentDisplays();
    const primary = screen.getPrimaryDisplay().id;
    windows.all().forEach((window, index) => {
        if (!window.bounds) return;
        const placed = placeWindow({ bounds: window.bounds, display: window.display }, now, primary, before, index);
        windows.setBounds(window.id, placed.bounds, placed.display, window.maximized === true);
        host.native(window.id)?.base.setBounds(placed.bounds);
    });
}

/** A monitor was plugged in or out: windows take their bounds saved for the new setup, or fall back from a gone display. */
function displaysChanged(): void {
    const now = currentDisplays();
    const saved = layouts[displayFingerprint(now)];
    for (const window of windows.all()) {
        const match = saved?.windows.find(w => w.id === window.id);
        if (match?.bounds) windows.setBounds(window.id, match.bounds, match.display, match.maximized === true);
    }
    placeWindows(displays);
    displays = now;
    saveSoon();
}

type DragKind = 'workspace' | 'repo' | 'pane';

/** The pane a dragged rail item stands for: a repo is its canvas. */
function paneOf(kind: DragKind, id: string): string {
    return kind === 'repo' ? paneId(IDE_PANE, id) : id;
}

/** A drag out of a window's rail ended at a screen point: into another window, or into a new window there. */
function detach(from: string, kind: DragKind, id: string, point: { x: number, y: number }): void {
    if (![point.x, point.y].every(Number.isFinite)) return;
    const target = dropTarget(point, from, host.bounds());
    if (target === 'new') newWindow(kind, id, point);
    else if (target) moveTo(kind, id, target);
}

/** Moves a workspace, a repo's canvas or a pane into a window of its own, at a screen point when given. */
function newWindow(kind: DragKind, id: string, point?: { x: number, y: number }): void {
    if (kind === 'workspace' ? !workspaces.get(id) : !parsePane(paneOf(kind, id))) return;
    const source = host.base()?.getBounds();
    const size = { width: Math.max(800, Math.round((source?.width ?? 1440) * 0.8)), height: Math.max(500, Math.round((source?.height ?? 900) * 0.8)) };
    const at = point ? { x: point.x - 80, y: point.y - 16 } : { x: (source?.x ?? 0) + 48, y: (source?.y ?? 0) + 48 };
    const now = currentDisplays();
    const display = displayOf({ ...at, width: 1, height: 1 }, now)?.id ?? screen.getPrimaryDisplay().id;
    const placed = placeWindow({ bounds: { ...at, ...size }, display }, now, screen.getPrimaryDisplay().id);
    const window = kind === 'workspace' ? windows.open({ workspaces: [id] }, placed.bounds) : windows.open({ panes: [paneOf(kind, id)] }, placed.bounds);
    window.display = placed.display;
    if (kind === 'workspace') workspaces.selectWorkspace(id);
    lastShown = shownKey();
    changed();
}

/**
 * Moves a dragged item into a window. A workspace goes to its rail. A repo or pane goes back to its repo's column
 * when the window holds a workspace of that repo (docking), else it gets a column of its own there.
 */
function moveTo(kind: DragKind, id: string, to: string): void {
    if (kind === 'workspace') {
        if (!workspaces.get(id) || !windows.moveWorkspace(id, to)) return;
        workspaces.selectWorkspace(id);
    } else {
        const pane = paneOf(kind, id);
        const repo = parsePane(pane)?.repo;
        if (!repo) return;
        const home = windows.workspacesOf(to, openIds()).find(w => workspaces.get(w)?.folders.some(f => f.path === repo));
        if (home) {
            windows.dockPane(pane);
            windows.get(to)!.active = home;
            workspaces.select(repo, home);
        } else if (!windows.movePane(pane, to)) return;
    }
    windows.focus(to);
    lastShown = shownKey();
    changed();
    host.show(to);
}

function focusPane(pane: string): void {
    const window = host.paneWindow(pane);
    if (!window) return;
    host.show(window);
    host.panes.get(pane)?.webContents.focus();
}

/** "Window 2" for the second window, "Main Window" for the first. */
function windowName(id: string): string {
    return id === MAIN ? 'Main Window' : `Window ${id.replace(/^w/, '')}`;
}

/** The menu items that move an item into a new window or another one. */
function moveItems(kind: DragKind, id: string, here: string): MenuItemConstructorOptions[] {
    const others = windows.all().filter(w => w.id !== here);
    return [
        { label: 'Move to New Window', click: () => newWindow(kind, id) },
        { label: 'Move to Window', enabled: others.length > 0, submenu: others.map(w => ({ label: windowName(w.id), click: () => moveTo(kind, id, w.id) })) }
    ];
}

/** The repo's other panes (the code view, terminals), each with its move items, for the repo's rail menu. */
function paneItems(repo: string, here: string): MenuItemConstructorOptions[] {
    const panes = [...host.panes.keys()].filter(p => parsePane(p)?.repo === repo && parsePane(p)?.type !== IDE_PANE && !host.isHidden(p));
    return panes.map(pane => ({
        label: `Move ${paneLabel(pane)}`,
        submenu: [...moveItems('pane', pane, here), ...(windows.windowOfPane(pane) ? [{ label: 'Dock Back', click: () => windows.dockPane(pane) && changed() }] : [])]
    }));
}

/** Closes the focused window other than the main one; its workspaces and panes go back. */
function dockWindow(): void {
    const window = windows.focused();
    if (window.id === MAIN) return;
    windows.close(window.id);
    changed();
}

/** Saves the session a moment after a window moved, so dragging a window does not write the file on every pixel. */
function saveSoon(): void {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 400);
}

function save(): void {
    clearTimeout(saveTimer);
    if (!app.isReady() || quitting) return;
    layouts = rememberLayout(layouts, windows.save(currentDisplays(), Date.now()));
    writeSession(userFile('session.json'), sessionOf(workspaces, layouts));
}

// ---- menu ----

const actions: Record<string, () => void> = {
    open: () => addFolderDialog(),
    clone: () => openClone(),
    addRemote: () => remoteForm.open(),
    openInContainer: () => remoteForm.openContainer(),
    closeRepo: () => { const repo = workspaces.activeRepo(); if (repo) closeRepo(repo); },
    switcher: () => host.covered(windows.focused().id, 'switcher') ? closeSwitcher() : openSwitcher(),
    nextRepo: () => workspaces.stepRecent(1, Date.now()) && changed(),
    previousRepo: () => workspaces.stepRecent(-1, Date.now()) && changed(),
    ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`repo${i + 1}`, () => workspaces.selectAt(i) && changed()])),
    newWorkspace: () => newWorkspaceDialog(),
    openWorkspace: () => openWorkspaceDialog(),
    closeWorkspace: () => workspaces.active && closeWorkspace(workspaces.active),
    nextWorkspace: () => { workspaces.cycleWorkspace(1); changed(); },
    previousWorkspace: () => { workspaces.cycleWorkspace(-1); changed(); },
    ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`workspace${i + 1}`, () => workspaces.selectWorkspaceAt(i) && changed()])),
    detachRepo: () => { const repo = workspaces.activeRepo(); if (repo) newWindow('repo', repo); },
    detachWorkspace: () => workspaces.active && newWindow('workspace', workspaces.active),
    dockWindow: () => dockWindow(),
    toggleRail: () => toggleRail(),
    toggleSource: () => activeView()?.webContents.executeJavaScript(`document.querySelector('.bar button[aria-pressed]')?.click()`),
    toggleCode: () => { const repo = workspaces.activeRepo(); if (repo) code?.toggle(repo); },
    openFileInVSCode: () => { const repo = workspaces.activeRepo(); if (repo) code?.openInVSCode(repo, true); },
    openRepoInVSCode: () => { const repo = workspaces.activeRepo(); if (repo) code?.openInVSCode(repo, false); },
    reload: () => activeView()?.webContents.reload(),
    devTools: () => (activeView()?.webContents ?? host.native(windows.focused().id)?.shell.webContents)?.toggleDevTools(),
    keybindings: () => {
        const file = keybindingsFile();
        if (!existsSync(file)) writeFileSync(file, '{\n}\n');
        shell.openPath(file);
    },
    checkForUpdates: () => updater.check(),
    quit: () => app.quit(),
    ...terminals.actions()
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
    terminals.bindings = bindings;
    if (problems.length) console.error(`Appling Desktop keybindings:\n  ${problems.join('\n  ')}`);
    const item = (command: string): MenuItemConstructorOptions => ({
        label: COMMANDS[command], accelerator: bindings[command] ?? undefined, click: actions[command]
    });
    const numbered = (prefix: string) => Array.from({ length: 9 }, (_, i) => item(`${prefix}${i + 1}`));
    const template: MenuItemConstructorOptions[] = [
        ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
        {
            label: 'File', submenu: [
                item('newWorkspace'), item('openWorkspace'), item('open'), item('clone'), item('addRemote'), item('openInContainer'), { type: 'separator' },
                item('closeRepo'), item('closeWorkspace'), { type: 'separator' }, item('keybindings'), item('checkForUpdates'), { type: 'separator' }, item('quit')
            ]
        },
        { role: 'editMenu' },
        { label: 'View', submenu: [item('toggleRail'), item('toggleSource'), item('toggleCode'), item('reload'), item('devTools'), { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
        { label: 'Repo', submenu: [item('switcher'), { type: 'separator' }, item('openFileInVSCode'), item('openRepoInVSCode'), { type: 'separator' }, item('nextRepo'), item('previousRepo'), { type: 'separator' }, ...numbered('repo')] },
        { label: 'Workspace', submenu: [item('nextWorkspace'), item('previousWorkspace'), { type: 'separator' }, ...numbered('workspace')] },
        { label: 'Terminal', submenu: terminals.menu(item) },
        { label: 'Window', submenu: [item('detachRepo'), item('detachWorkspace'), item('dockWindow'), { type: 'separator' }, { role: 'minimize' }] }
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

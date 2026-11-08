import { existsSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { app, clipboard, dialog, ipcMain, Menu, shell, WebContentsView, type BaseWindow, type IpcMainEvent, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron';
import type { CodeViews } from '../code-view.js';
import { readCodeWorkspace } from '../code-workspace.js';
import type { Keybindings } from '../keybindings.js';
import { openCommand, type AppLaunch } from '../app-flags.js';
import { registerPaneType, STRIP } from '../panes.js';
import { programPath } from '../resources.js';
import { asset } from './assets.js';
import { commandFor } from './keys.js';
import { isWebUrl, offsetAt } from './links.js';
import { terminalProfiles, vscodeSettingsFiles, type Platform, type Profiles } from './profiles.js';
import { END_WITH_APP, readSettingsFile, terminalSettings, writeSetting, type TerminalSettings } from './settings.js';
import { TerminalService, type CreateOptions, type RemoteTerminals } from './service.js';
import type { PanelCommand, PanelLayout } from './view-protocol.js';

const PAGE = asset('view/index.html');
const PRELOAD = asset('preload.cjs');
/** The pane type of a repo's terminal panel: a strip under the repo's view, which can move into another window. */
export const TERMINAL_PANE = 'terminal';

/** Opens a file a terminal links to, at a line and column. The code view (#8) replaces the default, the OS's app. */
export type FileOpener = (path: string, position: { line?: number, column?: number }, repo: string) => void;

export interface PanelOptions {
    userData: string;
    /** The repo shown in the window. */
    activeRepo(): string | undefined;
    /** The workspace files holding the repo, for the `settings` in them. */
    workspaceFiles(repo: string): string[];
    /** Runs a command of the app menu that works inside terminals too (`SKIP_SHELL`). */
    runCommand(command: string): void;
    /** Hands the repo's panel view to the windows as its `terminal` pane (`host.addPane`). */
    attach(repo: string, view: WebContentsView): void;
    /** Takes it back (`host.removePane`); the panel closes the view. */
    detach(repo: string): void;
    /** Hides the pane wherever it is (the panel is closed) or shows it again (`host.setHidden`). */
    setHidden(repo: string, hidden: boolean): void;
    /** Arranges the windows again. */
    refresh(): void;
    /** The window for the panel's context menus: the focused one. */
    window(): BaseWindow | undefined;
    /** Gives the focus back to the repo's own view when the panel hides. */
    focusRepoView(repo: string): void;
    /** Where a remote repo's terminals run (`TerminalServiceOptions.remote`). */
    remote?(repo: string): RemoteTerminals | undefined;
}

/**
 * The terminal panel of every repo, under its view: one kept alive `WebContentsView` per repo with the terminal page,
 * wired to the `TerminalService`. Electron glue only; the logic lives in the service, the registry, the profiles
 * and the settings.
 */
export class TerminalPanel {
    readonly service: TerminalService;
    private readonly views = new Map<string, WebContentsView>();
    /** The repos whose pane is shown, to arrange the windows when that changes. */
    private readonly openPanes = new Set<string>();
    private readonly repoBySender = new Map<number, string>();
    private readonly pending = new Map<string, string[]>();
    private readonly layoutsDue = new Set<string>();
    private flushTimer?: NodeJS.Timeout;
    private cachedSettings?: { settings: TerminalSettings, vscode: Record<string, unknown> };
    /** The profiles per repo, read again when the settings change and for every new terminal. */
    private readonly cachedProfiles = new Map<string, Profiles>();
    private watcher?: FSWatcher;
    private ended = false;
    /** The app menu's shortcuts, for the commands that pass through terminals. */
    bindings: Keybindings = {};
    /** How file links open; the default hands the file to the OS. */
    fileOpener: FileOpener = path => void shell.openPath(path);

    constructor(private readonly options: PanelOptions) {
        this.service = new TerminalService({
            registryFile: join(options.userData, 'terminals.json'),
            // a click on the host's notification for a terminal that needs input opens the app at it (`--session`)
            host: { host: { node: process.execPath, env: process.env, main: programPath('pty-host'), open: openCommand(appLaunch()) } },
            settings: () => this.settings(),
            profiles: repo => this.profiles(repo, true),
            version: app.getVersion(),
            remote: repo => options.remote?.(repo)
        });
        this.service.on('data', (id, data) => this.queue(id, data));
        this.service.on('exit', (id, exit) => {
            this.flush();
            this.viewOf(id)?.webContents.send('terminal:exit', id, exit);
        });
        this.service.on('changed', repo => this.layoutDue(repo));
        this.handle();
        try {
            this.watcher = watch(options.userData, (_, name) => {
                if (name !== 'settings.json') return;
                this.cachedSettings = undefined;
                this.cachedProfiles.clear();
                for (const repo of this.views.keys()) this.layoutDue(repo);
            });
        } catch {
            // settings then apply at the next start
        }
        app.on('before-quit', event => this.beforeQuit(event));
        registerPaneType({ type: TERMINAL_PANE, label: 'Terminal', region: 'bottom', share: STRIP });
    }

    /** Whether the windows were set up, so this is the instance that owns the terminals (not a second start). */
    private started = false;

    start(): void {
        this.started = true;
    }

    settingsFile(): string {
        return join(this.options.userData, 'settings.json');
    }

    /** The terminal settings: Appling's `settings.json` over VS Code's user settings. */
    settings(): TerminalSettings {
        if (!this.cachedSettings) {
            const own = readSettingsFile(this.settingsFile());
            const vscode = this.vscodeSettings();
            const { settings, problems } = terminalSettings(own.settings, vscode);
            for (const problem of [...own.problems, ...problems]) console.error(`Appling Desktop settings: ${problem}`);
            this.cachedSettings = { settings, vscode };
        }
        return this.cachedSettings.settings;
    }

    private vscodeSettings(): Record<string, unknown> {
        const file = vscodeSettingsFiles(process.platform as Platform, process.env, homedir()).find(f => existsSync(f));
        return file ? readSettingsFile(file).settings : {};
    }

    /** The profiles for the repo: detected shells, then VS Code's user, workspace and folder settings, then Appling's. */
    profiles(repo: string, fresh = false): Profiles {
        const cached = this.cachedProfiles.get(repo);
        if (cached && !fresh) return cached;
        this.settings();
        const layers: Record<string, unknown>[] = [this.cachedSettings!.vscode];
        for (const file of this.options.workspaceFiles(repo)) {
            try {
                const settings = readCodeWorkspace(file).data.settings;
                if (settings && typeof settings === 'object') layers.push(settings as Record<string, unknown>);
            } catch {
                // a workspace file that does not parse has no settings for us
            }
        }
        layers.push(readSettingsFile(join(repo, '.vscode', 'settings.json')).settings, readSettingsFile(this.settingsFile()).settings);
        const shells = (() => {
            try {
                return readFileSync('/etc/shells', 'utf8');
            } catch {
                return undefined;
            }
        })();
        const profiles = terminalProfiles({ platform: process.platform as Platform, env: process.env, exists: isFile, shells, settings: layers, workspaceFolder: repo });
        for (const problem of profiles.problems) console.error(`Terminal profiles of ${repo}: ${problem}`);
        this.cachedProfiles.set(repo, profiles);
        return profiles;
    }

    /** A repo became live: find its terminals in the pty host (after a restart too) and show the panel if it was open. */
    openRepo(repo: string): Promise<void> {
        return this.service.openRepo(repo).then(() => {
            const entry = this.service.registry.get(repo);
            if (entry.open && entry.tabs.length) this.ensureView(repo);
            this.arrange(repo);
        }, error => console.error(`The terminals of ${repo} did not reattach: ${(error as Error).message}`));
    }

    /** The repo whose terminal this is, from the pty host (also before the repo is open). */
    async repoOfTerminal(id: string): Promise<string | undefined> {
        const client = await this.service.connection();
        return (await client.list()).find(info => info.id === id)?.group;
    }

    /** Opens the repo's panel at the terminal's tab and focuses it (`--session`, a click on a notification). */
    async reveal(repo: string, id: string): Promise<void> {
        await this.service.openRepo(repo);
        // a repo that just went live may still be attaching its terminals
        for (let i = 0; i < 50 && !this.service.registry.repoOf(id); i++) await new Promise(done => setTimeout(done, 100));
        if (this.service.registry.repoOf(id) !== repo) return;
        this.service.update(repo, registry => registry.focus(id));
        this.service.update(repo, registry => registry.setOpen(repo, true));
        this.ensureView(repo).webContents.focus();
        this.arrange(repo);
    }

    /** The repo left every workspace: its terminals end and its panel goes. */
    closeRepo(repo: string): void {
        void this.service.closeRepo(repo);
        const view = this.views.get(repo);
        if (view) {
            this.views.delete(repo);
            this.repoBySender.delete(view.webContents.id);
            this.options.detach(repo);
            view.webContents.close();
        }
    }

    /** Shows or hides the repo's pane by whether its panel is open, at its height, and arranges the windows. */
    private arrange(repo: string): void {
        if (this.views.has(repo)) {
            const entry = this.service.registry.get(repo);
            this.options.setHidden(repo, !entry.open);
            // the strip's share is one for the pane type; the panel resized last sets it
            registerPaneType({ type: TERMINAL_PANE, label: 'Terminal', region: 'bottom', share: entry.height });
        }
        this.options.refresh();
    }

    /** The menu entries of the Terminal menu, built with the app menu's `item` for the shortcuts. */
    menu(item: (command: string) => MenuItemConstructorOptions): MenuItemConstructorOptions[] {
        return [
            item('newTerminal'), item('splitTerminal'), item('toggleTerminal'), { type: 'separator' },
            item('nextTerminal'), item('previousTerminal'), { type: 'separator' },
            item('findInTerminal'), item('clearTerminal'), item('killTerminal'), { type: 'separator' },
            {
                label: 'End Terminals with the App', type: 'checkbox', checked: this.settings().endWithApp,
                click: menuItem => this.setEndWithApp(menuItem.checked)
            },
            item('terminalSettings')
        ];
    }

    /** The actions of the terminal commands, for the app menu and the shortcuts. */
    actions(): Record<string, () => void> {
        const repo = () => this.options.activeRepo();
        const focused = () => {
            const id = repo();
            return id ? this.service.registry.focused(id) : undefined;
        };
        return {
            newTerminal: () => { const r = repo(); if (r) void this.create(r, {}); },
            splitTerminal: () => { const r = repo(); if (r) void this.create(r, { split: true }); },
            toggleTerminal: () => { const r = repo(); if (r) this.toggle(r); },
            nextTerminal: () => { const r = repo(); if (r) this.service.update(r, registry => registry.cycleTab(r, 1)); },
            previousTerminal: () => { const r = repo(); if (r) this.service.update(r, registry => registry.cycleTab(r, -1)); },
            findInTerminal: () => this.command('find'),
            clearTerminal: () => this.command('clear'),
            killTerminal: () => { const id = focused(); if (id) void this.service.kill(id); },
            terminalSettings: () => {
                const file = this.settingsFile();
                if (!existsSync(file)) writeSetting(file, END_WITH_APP, this.settings().endWithApp);
                void shell.openPath(file);
            }
        };
    }

    private setEndWithApp(value: boolean): void {
        try {
            writeSetting(this.settingsFile(), END_WITH_APP, value);
            this.cachedSettings = undefined;
            this.cachedProfiles.clear();
        } catch (error) {
            dialog.showErrorBox('The setting was not saved', (error as Error).message);
        }
    }

    /** Opens the panel (with a first terminal when it has none) or closes it and gives the focus back to the repo view. */
    toggle(repo: string): void {
        const entry = this.service.registry.get(repo);
        if (entry.open && this.views.get(repo)?.webContents.isFocused()) {
            this.service.update(repo, registry => registry.setOpen(repo, false));
            this.options.focusRepoView(repo);
        } else if (!entry.tabs.length) {
            void this.create(repo, {});
            return;
        } else {
            this.service.update(repo, registry => registry.setOpen(repo, true));
            this.ensureView(repo);
            this.command('focus');
        }
        this.arrange(repo);
    }

    async create(repo: string, options: CreateOptions): Promise<void> {
        this.ensureView(repo);
        try {
            await this.service.create(repo, options);
        } catch (error) {
            dialog.showErrorBox('The terminal did not start', (error as Error).message);
        }
        this.arrange(repo);
    }

    private command(command: PanelCommand): void {
        const repo = this.options.activeRepo();
        const view = repo ? this.views.get(repo) : undefined;
        if (!view) return;
        if (command === 'focus' || command === 'find') view.webContents.focus();
        view.webContents.send('terminal:command', command);
    }

    private ensureView(repo: string): WebContentsView {
        let view = this.views.get(repo);
        if (view) return view;
        view = new WebContentsView({ webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false } });
        view.setBackgroundColor('#0c0a08');
        const contents = view.webContents;
        // keys belong to the shell: the menu's shortcuts are off here, only the skip-shell commands pass
        contents.setIgnoreMenuShortcuts(true);
        contents.on('before-input-event', (event, input) => {
            const command = commandFor(input, this.bindings, process.platform === 'darwin');
            if (!command) return;
            event.preventDefault();
            this.options.runCommand(command);
        });
        contents.setWindowOpenHandler(() => ({ action: 'deny' }));
        contents.on('will-navigate', event => event.preventDefault());
        contents.on('render-process-gone', () => {
            // the page reloads; its terminals reattach with their scrollback
            if (!contents.isDestroyed()) contents.reload();
        });
        this.repoBySender.set(contents.id, repo);
        this.views.set(repo, view);
        void contents.loadFile(PAGE);
        this.options.setHidden(repo, !this.service.registry.get(repo).open);
        this.options.attach(repo, view);
        return view;
    }

    private viewOf(terminal: string): WebContentsView | undefined {
        const repo = this.service.registry.repoOf(terminal);
        return repo ? this.views.get(repo) : undefined;
    }

    /** Output goes to the page in batches, so a flood of small chunks does not become a flood of messages. */
    private queue(id: string, data: string): void {
        if (!this.viewOf(id)) return;
        const chunks = this.pending.get(id);
        if (chunks) chunks.push(data);
        else this.pending.set(id, [data]);
        this.flushTimer ??= setTimeout(() => this.flush(), 4);
    }

    private flush(): void {
        clearTimeout(this.flushTimer);
        this.flushTimer = undefined;
        for (const [id, chunks] of this.pending) {
            const view = this.viewOf(id);
            if (view && !view.webContents.isDestroyed()) view.webContents.send('terminal:data', id, chunks.join(''));
        }
        this.pending.clear();
        for (const repo of this.layoutsDue) this.pushLayout(repo);
        this.layoutsDue.clear();
    }

    private layoutDue(repo: string): void {
        this.layoutsDue.add(repo);
        this.flushTimer ??= setTimeout(() => this.flush(), 4);
    }

    private panelLayout(repo: string): PanelLayout {
        const settings = this.settings();
        const profiles = this.profiles(repo);
        const names = profiles.profiles.map(p => p.name);
        const first = settings.defaultProfile && names.includes(settings.defaultProfile) ? settings.defaultProfile : profiles.default;
        return {
            ...this.service.layout(repo), repo,
            profiles: first ? [first, ...names.filter(n => n !== first)] : names,
            settings: { fontSize: settings.fontSize, fontFamily: settings.fontFamily, scrollback: settings.scrollback, cursorBlink: settings.cursorBlink },
            mac: process.platform === 'darwin'
        };
    }

    private pushLayout(repo: string): void {
        const view = this.views.get(repo);
        if (!view || view.webContents.isDestroyed()) return;
        view.webContents.send('terminal:layout', this.panelLayout(repo));
        const open = this.service.registry.get(repo).open;
        if (open !== this.openPanes.has(repo)) {
            if (open) this.openPanes.add(repo);
            else this.openPanes.delete(repo);
            this.arrange(repo);
        }
    }

    private handle(): void {
        const repoOf = (event: IpcMainEvent | IpcMainInvokeEvent) => this.repoBySender.get(event.sender.id);
        const own = (event: IpcMainEvent | IpcMainInvokeEvent, id: unknown): id is string =>
            typeof id === 'string' && repoOf(event) !== undefined && this.service.registry.repoOf(id) === repoOf(event);
        ipcMain.handle('terminal:layout', event => {
            const repo = repoOf(event);
            return repo ? this.panelLayout(repo) : undefined;
        });
        ipcMain.on('terminal:attach', (event, id, cols, rows) => {
            if (!own(event, id)) return;
            const size = Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0 ? { cols, rows } : undefined;
            this.service.snapshot(id, size).then(({ scrollback, resume }) => {
                // output queued before the snapshot is part of it
                this.pending.delete(id);
                if (!event.sender.isDestroyed()) event.sender.send('terminal:snapshot', id, scrollback);
                resume();
            }, error => console.error(`Terminal ${id} did not attach: ${(error as Error).message}`));
        });
        ipcMain.on('terminal:input', (event, id, data) => own(event, id) && typeof data === 'string' && this.service.write(id, data));
        ipcMain.on('terminal:resize', (event, id, cols, rows) => {
            if (own(event, id) && Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0) void this.service.resize(id, cols, rows);
        });
        ipcMain.on('terminal:create', (event, options) => {
            const repo = repoOf(event);
            if (repo) void this.create(repo, { profile: typeof options?.profile === 'string' ? options.profile : undefined, split: options?.split === true });
        });
        ipcMain.on('terminal:profileMenu', (event, split) => {
            const repo = repoOf(event);
            const window = this.options.window();
            if (!repo || !window) return;
            Menu.buildFromTemplate(this.profiles(repo, true).profiles.map(profile => ({
                label: profile.name, click: () => void this.create(repo, { profile: profile.name, split: split === true })
            }))).popup({ window });
        });
        ipcMain.on('terminal:tabMenu', (event, id) => {
            const repo = repoOf(event);
            const window = this.options.window();
            if (!repo || !own(event, id) || !window) return;
            Menu.buildFromTemplate([
                { label: 'Split Terminal', click: () => { this.service.update(repo, r => r.focus(id)); void this.create(repo, { split: true }); } },
                { label: 'Clear', click: () => event.sender.send('terminal:command', 'clear') },
                { label: 'Find…', click: () => event.sender.send('terminal:command', 'find') },
                { type: 'separator' },
                { label: 'Send Interrupt (SIGINT)', click: () => void this.service.signal(id, 'SIGINT').catch(() => undefined) },
                { label: 'Kill Terminal', click: () => void this.service.kill(id) }
            ]).popup({ window });
        });
        ipcMain.on('terminal:close', (event, id) => own(event, id) && void this.service.kill(id));
        ipcMain.on('terminal:focus', (event, id) => {
            const repo = repoOf(event);
            if (repo && own(event, id)) this.service.update(repo, registry => registry.focus(id));
        });
        ipcMain.on('terminal:rename', (event, id, name) => {
            const repo = repoOf(event);
            if (repo && own(event, id) && typeof name === 'string') this.service.update(repo, registry => registry.rename(id, name));
        });
        ipcMain.on('terminal:moveTab', (event, id, to) => {
            const repo = repoOf(event);
            if (repo && typeof id === 'string' && Number.isInteger(to)) this.service.update(repo, registry => registry.moveTab(repo, id, to));
        });
        ipcMain.on('terminal:hide', event => {
            const repo = repoOf(event);
            if (!repo) return;
            this.service.update(repo, registry => registry.setOpen(repo, false));
            this.options.focusRepoView(repo);
            this.arrange(repo);
        });
        ipcMain.on('terminal:resizePanel', (event, deltaY) => {
            const repo = repoOf(event);
            const view = repo ? this.views.get(repo) : undefined;
            if (!repo || !view || typeof deltaY !== 'number') return;
            // the strip's height over its share is the height of the repo's column
            const entry = this.service.registry.get(repo);
            const column = view.getBounds().height / entry.height;
            if (column > 0 && this.service.update(repo, registry => registry.setHeight(repo, entry.height - deltaY / column))) this.arrange(repo);
        });
        ipcMain.on('terminal:openLink', (event, id, uri) => {
            const repo = repoOf(event);
            if (!repo || !own(event, id) || typeof uri !== 'string') return;
            if (isWebUrl(uri)) void shell.openExternal(uri);
            else if (uri.startsWith('file:')) {
                try {
                    const path = fileURLToPath(uri);
                    if (existsSync(path)) this.fileOpener(path, {}, repo);
                } catch {
                    // not a local file
                }
            }
        });
        ipcMain.handle('terminal:resolveFile', (event, id, path) => own(event, id) && typeof path === 'string' ? this.resolveFile(id, path) : undefined);
        ipcMain.on('terminal:openFile', (event, id, path, line, column) => {
            const repo = repoOf(event);
            if (!repo || !own(event, id) || typeof path !== 'string' || !existsSync(path)) return;
            this.fileOpener(path, { ...Number.isInteger(line) ? { line } : {}, ...Number.isInteger(column) ? { column } : {} }, repo);
        });
        ipcMain.on('terminal:copy', (event, text) => repoOf(event) && typeof text === 'string' && clipboard.writeText(text));
        ipcMain.handle('terminal:paste', event => repoOf(event) ? clipboard.readText() : '');
    }

    /** A path a terminal printed, against its working directory; undefined unless the file or folder exists. */
    private resolveFile(id: string, path: string): string | undefined {
        const state = this.service.state(id);
        if (!state) return undefined;
        const expanded = path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
        const absolute = resolve(state.cwd, expanded);
        return existsSync(absolute) ? absolute : undefined;
    }

    /** With `endWithApp` the quit waits (at most a few seconds) until every terminal ended. */
    private beforeQuit(event: Electron.Event): void {
        this.watcher?.close();
        // a second instance that only handed its paths over never started and must not end anything
        if (this.ended || !this.started || !this.settings().endWithApp) {
            this.service.dispose();
            return;
        }
        event.preventDefault();
        this.ended = true;
        const timeout = new Promise(done => setTimeout(done, 3000));
        void Promise.race([this.service.endAll(), timeout]).finally(() => {
            this.service.dispose();
            app.quit();
        });
    }
}

/** A file opener for the code view: a file of the repo opens there at its line and column, anything else in the OS. */
export function codeViewOpener(code: CodeViews): FileOpener {
    return (path, { line, column }, repo) => {
        const inside = !relative(repo, path).startsWith('..');
        const text = inside && isFile(path) && statSync(path).size < 8 * 1024 * 1024 ? readFileSync(path, 'utf8') : undefined;
        if (text === undefined || text.includes('\0')) return void shell.openPath(path);
        if (!code.isShown(repo)) code.toggle(repo);
        code.selected(repo, { uri: pathToFileURL(path).href, start: offsetAt(text, line, column) });
    };
}

function isFile(path: string): boolean {
    try {
        return statSync(path).isFile();
    } catch {
        return false;
    }
}

/** How the pty host and the tray start this app. */
export function appLaunch(): AppLaunch {
    return { execPath: process.execPath, main: fileURLToPath(new URL('../main.js', import.meta.url)), packaged: app.isPackaged, appImage: process.env.APPIMAGE };
}

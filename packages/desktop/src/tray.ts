import { spawn } from 'node:child_process';
import { connectPtyHost, systemNotifier, type PtyHostClient, type TerminalInfo } from '@appling/pty-host';
import { app, Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron';
import { trayEntries, trayTooltip } from './tray-menu.js';
import { describeLocation, parseLocation, type RemoteLocation } from './remote/location.js';
import { appRunning, knownRemoteRepos, TrayRemotes } from './remote/tray-remotes.js';

export interface TrayOptions {
    /** The tray icon's file. */
    icon: string;
    /** How to start the app with arguments (`appCommand` in `app-flags.ts`). */
    command(args: string[]): string[];
    /** The app's user data folder: its saved workspaces name the remote repos, its presence mark tells whether it runs. */
    appUserData: string;
    /** The tray's own user data folder. */
    userData: string;
    /** The server bundle for remote installs (`serverBundle()`). */
    serverBundle(): string;
}

/**
 * The tray only mode (`--tray`): no windows, one icon that lists the pty host's sessions with their status and opens
 * the app at one or stops it. While the app is closed it also follows the pty hosts of the saved workspaces' remote
 * repos (`remote/tray-remotes.ts`): their sessions are listed, stopped and notified here. It owns no terminals and does not start the host; it follows the one that runs, and
 * looks again every few seconds while none does. Electron glue only; the entries come from `tray-menu.ts`.
 */
export function startTray(options: TrayOptions): void {
    if (!app.requestSingleInstanceLock()) return void app.quit();
    app.dock?.hide();
    // without windows Electron would otherwise stay up anyway; quitting is the menu's job
    app.on('window-all-closed', () => undefined);
    const tray = new Tray(nativeImage.createFromPath(options.icon).resize({ width: 22, height: 22 }));
    const terminals = new Map<string, TerminalInfo>();
    let client: PtyHostClient | undefined;

    const run = (args: string[]) => {
        const [command, ...rest] = options.command(args);
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        spawn(command, rest, { detached: true, stdio: 'ignore', env }).unref();
    };
    // remote repos (#18): while the app is closed the tray follows their pty hosts, raises their notifications and lists them
    const remotes = new TrayRemotes({
        userData: options.userData,
        app: options.serverBundle,
        notifier: systemNotifier(),
        open: repo => run(['--', repo]),
        onChange: () => render(),
        log: message => console.error(message)
    });
    const where = (repo: string) => {
        try {
            return describeLocation(parseLocation(repo) as RemoteLocation);
        } catch {
            return repo;
        }
    };
    const followRemotes = () => remotes.follow(appRunning(options.appUserData) ? [] : knownRemoteRepos(options.appUserData));
    setInterval(followRemotes, 5000).unref();
    setInterval(() => remotes.retry(), 30000).unref();
    app.on('will-quit', () => void remotes.close());

    const render = () => {
        const remote = remotes.terminals().map(r => ({ ...r, where: where(r.repo) }));
        const list = [...terminals.values(), ...remote.flatMap(r => r.terminals)];
        const entries = trayEntries([...terminals.values()], remote);
        const items: MenuItemConstructorOptions[] = entries.length
            ? entries.map(entry => ({
                label: `${entry.needsInput ? '● ' : ''}${entry.label} (${entry.status})`,
                submenu: entry.repo ? [
                    { label: 'Open in Appling', click: () => run(['--', entry.repo!]) },
                    { label: entry.running ? 'Stop' : 'Remove', click: () => void remotes.kill(entry.repo!, entry.id).catch(() => undefined) }
                ] : [
                    { label: 'Open in Appling', click: () => run(['--session', entry.id]) },
                    { label: entry.running ? 'Stop' : 'Remove', click: () => void client?.kill(entry.id) }
                ]
            }))
            : [{ label: client || remote.length ? 'No sessions' : 'No sessions running', enabled: false }];
        tray.setContextMenu(Menu.buildFromTemplate([
            ...items,
            { type: 'separator' },
            { label: 'Open Appling', click: () => run([]) },
            { label: 'Stop All Sessions', enabled: entries.some(e => e.running), click: () => { void client?.shutdown(); void remotes.stopAll(); } },
            { label: 'Quit Tray', click: () => app.quit() }
        ]));
        tray.setToolTip(trayTooltip(list, !!client || remote.length > 0));
    };
    const connect = async () => {
        try {
            const connection = await connectPtyHost({ start: false });
            client = connection;
            connection.on('terminal', info => (terminals.set(info.id, info), render()));
            connection.on('status', (id, status) => {
                const info = terminals.get(id);
                if (info) terminals.set(id, { ...info, status });
                render();
            });
            connection.on('removed', id => (terminals.delete(id), render()));
            connection.on('close', () => {
                client = undefined;
                terminals.clear();
                render();
                setTimeout(connect, 5000);
            });
            for (const info of await connection.subscribe()) terminals.set(info.id, info);
            render();
        } catch {
            render();
            setTimeout(connect, 5000);
        }
    };
    render();
    void connect();
    followRemotes();
}

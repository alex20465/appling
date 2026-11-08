import { spawn } from 'node:child_process';
import { connectPtyHost, type PtyHostClient, type TerminalInfo } from '@appling/pty-host';
import { app, Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron';
import { trayEntries, trayTooltip } from './tray-menu.js';

export interface TrayOptions {
    /** The tray icon's file. */
    icon: string;
    /** How to start the app with arguments (`appCommand` in `app-flags.ts`). */
    command(args: string[]): string[];
}

/**
 * The tray only mode (`--tray`): no windows, one icon that lists the pty host's sessions with their status and opens
 * the app at one or stops it. It owns no terminals and does not start the host; it follows the one that runs, and
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
    const render = () => {
        const list = [...terminals.values()];
        const entries = trayEntries(list);
        const items: MenuItemConstructorOptions[] = entries.length
            ? entries.map(entry => ({
                label: `${entry.needsInput ? '● ' : ''}${entry.label} (${entry.status})`,
                submenu: [
                    { label: 'Open in Appling', click: () => run(['--session', entry.id]) },
                    { label: entry.running ? 'Stop' : 'Remove', click: () => void client?.kill(entry.id) }
                ]
            }))
            : [{ label: client ? 'No sessions' : 'No sessions running', enabled: false }];
        tray.setContextMenu(Menu.buildFromTemplate([
            ...items,
            { type: 'separator' },
            { label: 'Open Appling', click: () => run([]) },
            { label: 'Stop All Sessions', enabled: entries.some(e => e.running), click: () => void client?.shutdown() },
            { label: 'Quit Tray', click: () => app.quit() }
        ]));
        tray.setToolTip(trayTooltip(list, !!client));
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
}

/**
 * The app's own command line flags, before any `--`: `--session <terminal>` opens the app at a terminal of the pty
 * host (what a click on the host's notification runs), `--tray` starts the tray only mode (`tray.ts`).
 */
export const SESSION_FLAG = '--session';
export const TRAY_FLAG = '--tray';

/** The arguments before `--` (after it come only paths). */
function options(argv: string[]): string[] {
    const at = argv.indexOf('--');
    return at >= 0 ? argv.slice(0, at) : argv;
}

/** The terminal of `--session <id>` or `--session=<id>`. */
export function sessionArg(argv: string[]): string | undefined {
    const args = options(argv);
    for (let i = 0; i < args.length; i++) {
        if (args[i] === SESSION_FLAG && args[i + 1] && !args[i + 1].startsWith('-')) return args[i + 1];
        if (args[i].startsWith(`${SESSION_FLAG}=`)) return args[i].slice(SESSION_FLAG.length + 1) || undefined;
    }
    return undefined;
}

export function trayMode(argv: string[]): boolean {
    return options(argv).includes(TRAY_FLAG);
}

/** The arguments without the app's flags (and the value of `--session`), so the rest can be read as paths. */
export function withoutAppFlags(argv: string[]): string[] {
    const out: string[] = [];
    let paths = false;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--') paths = true;
        if (!paths && arg === SESSION_FLAG) {
            i++;
            continue;
        }
        if (!paths && (arg === TRAY_FLAG || arg.startsWith(`${SESSION_FLAG}=`))) continue;
        out.push(arg);
    }
    return out;
}

export interface AppLaunch {
    /** `process.execPath`: Electron's binary in development, the app's executable when packaged. */
    execPath: string;
    /** Desktop's main file, which a development Electron needs as its first argument. */
    main: string;
    packaged: boolean;
    /** `$APPIMAGE`: the AppImage file, since `execPath` lies in its mount, which goes away with the app. */
    appImage?: string;
}

/** How to start the app with `args`, from another process (the pty host, the tray). */
export function appCommand(launch: AppLaunch, args: string[]): string[] {
    if (!launch.packaged) return [launch.execPath, launch.main, ...args];
    return [launch.appImage || launch.execPath, ...args];
}

/** The pty host's open command: the app at the clicked terminal, `{terminal}` standing for its id. */
export function openCommand(launch: AppLaunch): string[] {
    return appCommand(launch, [SESSION_FLAG, '{terminal}']);
}

import { describeStatus, type TerminalInfo } from '@appling/pty-host';

/** One session (a terminal of the pty host) as the tray lists it. */
export interface TrayEntry {
    id: string;
    /** The agent session's label, else the terminal's title or program, and the repo folder's name. */
    label: string;
    /** `running`, `needs input`, `exited 3`. */
    status: string;
    needsInput: boolean;
    running: boolean;
    /** The remote repo whose pty host runs the session (#18); absent for the local host's. */
    repo?: string;
}

/** The sessions of a remote repo's pty host, as the tray follows them while the app is closed. */
export interface RemoteSessions {
    repo: string;
    /** Where it runs, such as `build@box` or `container shop`. */
    where: string;
    terminals: TerminalInfo[];
}

function lastPart(path: string): string {
    return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/**
 * The sessions, the local host's and those of remote repos, the ones waiting for input first, then the running ones,
 * then the ended ones; the newest first in each. A remote one names where it runs.
 */
export function trayEntries(terminals: TerminalInfo[], remote: RemoteSessions[] = []): TrayEntry[] {
    const rank = (t: TerminalInfo) => t.status.state === 'needsInput' ? 0 : t.status.state === 'running' ? 1 : 2;
    const all = [
        ...terminals.map(terminal => ({ terminal, remote: undefined as RemoteSessions | undefined })),
        ...remote.flatMap(r => r.terminals.map(terminal => ({ terminal, remote: r })))
    ];
    return all
        .sort((a, b) => rank(a.terminal) - rank(b.terminal) || b.terminal.created - a.terminal.created)
        .map(({ terminal: t, remote }) => ({
            id: t.id,
            label: [t.meta?.label ?? t.title ?? lastPart(t.shell), t.group ? lastPart(t.group) : undefined].filter(Boolean).join(' · ') + (remote ? ` on ${remote.where}` : ''),
            status: describeStatus(t.status),
            needsInput: t.status.state === 'needsInput',
            running: t.status.state !== 'exited',
            ...(remote && { repo: remote.repo })
        }));
}

/** The tray's tooltip: how many sessions run and how many wait for input. */
export function trayTooltip(terminals: TerminalInfo[], connected: boolean): string {
    if (!connected) return 'Appling: no sessions running';
    const running = terminals.filter(t => t.status.state !== 'exited').length;
    const waiting = terminals.filter(t => t.status.state === 'needsInput').length;
    return `Appling: ${running} session${running === 1 ? '' : 's'} running${waiting ? `, ${waiting} need${waiting === 1 ? 's' : ''} input` : ''}`;
}

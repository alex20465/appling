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
}

function lastPart(path: string): string {
    return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** The sessions, the ones waiting for input first, then the running ones, then the ended ones; the newest first in each. */
export function trayEntries(terminals: TerminalInfo[]): TrayEntry[] {
    const rank = (t: TerminalInfo) => t.status.state === 'needsInput' ? 0 : t.status.state === 'running' ? 1 : 2;
    return [...terminals]
        .sort((a, b) => rank(a) - rank(b) || b.created - a.created)
        .map(t => ({
            id: t.id,
            label: [t.meta?.label ?? t.title ?? lastPart(t.shell), t.group ? lastPart(t.group) : undefined].filter(Boolean).join(' · '),
            status: describeStatus(t.status),
            needsInput: t.status.state === 'needsInput',
            running: t.status.state !== 'exited'
        }));
}

/** The tray's tooltip: how many sessions run and how many wait for input. */
export function trayTooltip(terminals: TerminalInfo[], connected: boolean): string {
    if (!connected) return 'Appling: no sessions running';
    const running = terminals.filter(t => t.status.state !== 'exited').length;
    const waiting = terminals.filter(t => t.status.state === 'needsInput').length;
    return `Appling: ${running} session${running === 1 ? '' : 's'} running${waiting ? `, ${waiting} need${waiting === 1 ? 's' : ''} input` : ''}`;
}

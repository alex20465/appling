import type { RepoTerminals } from './registry.js';
import type { TerminalState } from './service.js';

/** What the main process sends a repo's terminal panel page: its tabs and splits, terminals and settings. */
export interface PanelLayout extends RepoTerminals {
    repo: string;
    terminals: Record<string, TerminalState>;
    /** The profile names for the new terminal menu, the default first. */
    profiles: string[];
    settings: { fontSize: number, fontFamily: string, scrollback: number, cursorBlink: boolean };
    mac: boolean;
    /** The agent session (#10) of each agent tab, by terminal id: its title (label, else the agent's name) and status. */
    agents: Record<string, { session: string, title: string, status: string, statusColor: string, color: string, note?: string }>;
}

/** Commands the main process forwards to the page (from the menu or a shortcut). */
export type PanelCommand = 'find' | 'clear' | 'selectAll' | 'copy' | 'paste' | 'previousCommand' | 'nextCommand' | 'focus';

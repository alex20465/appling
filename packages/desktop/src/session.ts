import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { readCodeWorkspace } from './code-workspace.js';
import type { SavedLayout } from './windows.js';
import { Workspaces, type RailLayout } from './workspaces.js';

/** What the app restores after a restart; written to `session.json` in the user data folder on every change. */
export interface Session {
    /** The open workspace files in rail order. */
    workspaces: string[];
    active?: string;
    /** The repo shown per workspace file. */
    shown: Record<string, string>;
    /** Repos, the most recently shown first. */
    recent: string[];
    /** The pinned and hidden repos per workspace file; their order is the file's folder order. */
    rail: Record<string, RailLayout>;
    /** Whether the rail is folded away. */
    collapsed: boolean;
    /** The window layout per monitor setup, keyed by `displayFingerprint` (see `windows.ts`). */
    layouts: Record<string, SavedLayout>;
    /** The repos whose code view is open (#8); each opens again once its repo is in sight. */
    code: string[];
}

export function sessionOf(workspaces: Workspaces, layouts: Record<string, SavedLayout> = {}, code: readonly string[] = []): Session {
    return {
        workspaces: workspaces.all().map(w => w.id),
        active: workspaces.active,
        shown: Object.fromEntries(workspaces.all().filter(w => w.active).map(w => [w.id, w.active!])),
        recent: workspaces.mostRecent(),
        rail: Object.fromEntries(workspaces.all().filter(w => w.pinned.length || w.hidden.length).map(w => [w.id, { pinned: [...w.pinned], hidden: [...w.hidden] }])),
        collapsed: workspaces.collapsed,
        layouts,
        code: [...code]
    };
}

export function readSession(file: string): Session | undefined {
    if (!existsSync(file)) return undefined;
    try {
        const session = JSON.parse(readFileSync(file, 'utf8')) as Partial<Session>;
        return Array.isArray(session.workspaces) ? {
                workspaces: session.workspaces, active: session.active, shown: session.shown ?? {}, recent: session.recent ?? [],
                rail: session.rail && typeof session.rail === 'object' ? session.rail : {}, collapsed: session.collapsed === true,
                layouts: session.layouts && typeof session.layouts === 'object' && !Array.isArray(session.layouts) ? session.layouts : {},
                code: Array.isArray(session.code) ? session.code.filter((repo): repo is string => typeof repo === 'string') : []
            }
            : undefined;
    } catch {
        return undefined;
    }
}

export function writeSession(file: string, session: Session): void {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(session, null, 2)}\n`);
}

/**
 * Reopens the workspaces of a session from their files, which may have changed since (in VS Code too), with the
 * repo shown per workspace, the active workspace, the most recently used order, the pinned and hidden repos and the
 * collapsed rail. Returns one problem per
 * workspace file that is gone or does not parse; those are left out.
 */
export function restore(session: Session, workspaces: Workspaces): string[] {
    const problems: string[] = [];
    for (const file of session.workspaces) {
        try {
            workspaces.open(file, readCodeWorkspace(file).folders);
        } catch (error) {
            problems.push(existsSync(file) ? (error as Error).message : `${file}: the workspace file is gone`);
        }
    }
    workspaces.arrange(session);
    return problems;
}

import type { Windows } from './windows.js';
import type { Workspace } from './workspaces.js';

/**
 * The workspace a repo's view belongs to now (#19 with #14): a folder may sit in several workspaces and still has one
 * view, which goes to the window that shows it. The view belongs to the workspace that window shows when that one
 * holds the repo, else to the first workspace of that window holding it (a pane moved into a window of another
 * workspace), else to the first open workspace holding it. Its playbook and context are that workspace's.
 */
export function viewWorkspace(repo: string, window: string | undefined, windows: Windows, workspaces: readonly Workspace[]): string | undefined {
    const holds = (id?: string) => !!id && !!workspaces.find(w => w.id === id)?.folders.some(f => f.path === repo);
    const open = workspaces.map(w => w.id);
    if (window) {
        const active = windows.activeOf(window, open);
        if (holds(active)) return active;
        const held = windows.workspacesOf(window, open).find(id => holds(id));
        if (held) return held;
    }
    return open.find(id => holds(id));
}

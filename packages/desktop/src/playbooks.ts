import { MemoryPlaybookStore, type Playbook } from '@appling/ai';
import { playbookContributions, type RailSource } from './rail-status.js';

/**
 * The playbooks of every workspace (#19), in the main process next to the agent sessions: every repo's IDE server
 * reaches this one store over its IPC channel (`startIdeProcess` with `playbooks`), so the sessions of all repos of a
 * workspace write one playbook. Each playbook is kept as a JSON file in the folder (the app's data folder), so it
 * survives the sessions and the app.
 */
export function desktopPlaybooks(folder: string): MemoryPlaybookStore {
    return new MemoryPlaybookStore(folder);
}

/**
 * Feeds the unwatched chapters of the playbooks of open workspaces (and of repos without a workspace) into the rail's
 * playbook source, now and after every change. Returns the function that stops and a `refresh` for when the open
 * workspaces change.
 */
export function playbookRail(store: MemoryPlaybookStore, source: RailSource, open: (workspace: string) => boolean): { refresh(): void, stop(): void } {
    const books = new Map<string, Playbook>(store.all().map(book => [book.workspace, book]));
    const refresh = () => source.replace(playbookContributions([...books.values()].filter(book => open(book.workspace))));
    const stop = store.onChange(book => {
        books.set(book.workspace, book);
        refresh();
    });
    refresh();
    return { refresh, stop };
}

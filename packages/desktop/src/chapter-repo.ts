import { posix, resolve } from 'node:path';
import { isRemoteId } from './remote/location.js';

/**
 * The repo of a workspace a playbook chapter belongs to (#19). A chapter names its repo by the folder its IDE server
 * runs in: a local folder is the repo's id, a remote repo's folder is its root on the other machine. A chapter's diff
 * jumps to that repo's Changes tab, so it must find the repo among the workspace's folders.
 */
export function chapterRepo(chapter: string, folders: readonly string[], remoteRoot: (repo: string) => string | undefined): string | undefined {
    if (folders.includes(chapter)) return chapter;
    for (const folder of folders) {
        if (isRemoteId(folder)) {
            const root = remoteRoot(folder);
            if (root && posix.normalize(root) === posix.normalize(chapter)) return folder;
        } else if (!isRemoteId(chapter) && resolve(folder) === resolve(chapter)) return folder;
    }
    return undefined;
}

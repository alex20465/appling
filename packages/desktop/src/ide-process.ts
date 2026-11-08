import { startIdeProcess as start, type IdeProcess, type IdeProcessOptions } from '@appling/ide/process';
import { programPath } from './resources.js';

export type { CodeMarks, IdeProcess, IdeProcessOptions, IdeStatus } from '@appling/ide/process';

/** The IDE server's entry, `out/server/main.js` of `@appling/ide`: bundled in the packaged app, else the workspace package's. */
export function ideMain(): string {
    return programPath('ide');
}

/** Starts a repo's IDE server (`startIdeProcess` of `@appling/ide`) from the entry Desktop ships. */
export function startIdeProcess(root: string, options: IdeProcessOptions = {}): Promise<IdeProcess> {
    return start(root, { main: ideMain(), ...options });
}

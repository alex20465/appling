import { existsSync, readFileSync } from 'node:fs';

/** Every command of the app menu, with its label. */
export const COMMANDS = {
    open: 'Add Folder to Workspace…',
    closeRepo: 'Close Repo',
    nextRepo: 'Recent Repo',
    previousRepo: 'Recent Repo, Backwards',
    ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`repo${i + 1}`, `Repo ${i + 1}`])),
    newWorkspace: 'New Workspace…',
    openWorkspace: 'Open Workspace…',
    closeWorkspace: 'Close Workspace',
    nextWorkspace: 'Next Workspace',
    previousWorkspace: 'Previous Workspace',
    ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`workspace${i + 1}`, `Workspace ${i + 1}`])),
    toggleSource: 'Toggle Source',
    reload: 'Reload Repo View',
    devTools: 'Toggle Developer Tools',
    keybindings: 'Keyboard Shortcuts',
    quit: 'Quit'
} as Record<string, string>;

export type Keybindings = Record<string, string | null>;

/** Electron accelerators; `null` leaves a command without a shortcut. */
export const DEFAULT_KEYBINDINGS: Keybindings = {
    open: 'CmdOrCtrl+O',
    closeRepo: 'CmdOrCtrl+W',
    nextRepo: 'Ctrl+Tab',
    previousRepo: 'Ctrl+Shift+Tab',
    ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`repo${i + 1}`, `CmdOrCtrl+${i + 1}`])),
    newWorkspace: 'CmdOrCtrl+Shift+N',
    openWorkspace: 'CmdOrCtrl+Shift+O',
    closeWorkspace: 'CmdOrCtrl+Shift+W',
    nextWorkspace: 'CmdOrCtrl+PageDown',
    previousWorkspace: 'CmdOrCtrl+PageUp',
    ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`workspace${i + 1}`, `CmdOrCtrl+Alt+${i + 1}`])),
    toggleSource: 'CmdOrCtrl+E',
    reload: 'CmdOrCtrl+R',
    devTools: 'CmdOrCtrl+Alt+I',
    keybindings: 'CmdOrCtrl+K',
    quit: 'CmdOrCtrl+Q'
};

const KEY = /^(?:(?:Command|Cmd|Control|Ctrl|CommandOrControl|CmdOrCtrl|Alt|Option|AltGr|Shift|Super|Meta)\+)*(?:[0-9A-Z]|F(?:[1-9]|1[0-9]|2[0-4])|[-=;',./\\`[\]]|Plus|Space|Tab|Capslock|Numlock|Scrolllock|Backspace|Delete|Insert|Return|Enter|Up|Down|Left|Right|Home|End|PageUp|PageDown|Escape|Esc|PrintScreen|num[0-9]|numdec|numadd|numsub|nummult|numdiv)$/i;

/**
 * The user's keybindings file (`{ "command": "Accelerator" | null }`) over the defaults. Unknown commands and
 * malformed accelerators are skipped and reported, so a typo never takes the menu down.
 */
export function loadKeybindings(file: string): { bindings: Keybindings, problems: string[] } {
    const bindings = { ...DEFAULT_KEYBINDINGS };
    const problems: string[] = [];
    if (!existsSync(file)) return { bindings, problems };
    let user: unknown;
    try {
        user = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
        return { bindings, problems: [`${file}: ${(error as Error).message}`] };
    }
    if (!user || typeof user !== 'object' || Array.isArray(user)) return { bindings, problems: [`${file}: expected an object of command to shortcut`] };
    for (const [command, accelerator] of Object.entries(user)) {
        if (!(command in COMMANDS)) problems.push(`unknown command "${command}"`);
        else if (accelerator === null || accelerator === '') bindings[command] = null;
        else if (typeof accelerator !== 'string' || !KEY.test(accelerator)) problems.push(`invalid shortcut ${JSON.stringify(accelerator)} for "${command}"`);
        else bindings[command] = accelerator;
    }
    return { bindings, problems };
}

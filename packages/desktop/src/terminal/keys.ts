/**
 * Keys inside a terminal belong to the shell: Ctrl+R, Ctrl+W, Ctrl+B and the like must reach it, so the terminal
 * views ignore the app menu's shortcuts. Only the commands in `SKIP_SHELL` still work there (VS Code calls this
 * `commandsToSkipShell`); `commandFor` finds the one a key press triggers.
 */

/** The menu commands that run even while a terminal has the focus. */
export const SKIP_SHELL = new Set([
    'nextRepo', 'previousRepo', 'nextWorkspace', 'previousWorkspace',
    ...Array.from({ length: 9 }, (_, i) => `workspace${i + 1}`),
    'toggleTerminal', 'newTerminal', 'splitTerminal', 'nextTerminal', 'previousTerminal', 'devTools'
]);

/** A key press as Electron's `before-input-event` reports it. */
export interface KeyInput {
    type: string;
    key: string;
    /** The physical key, `KeyA`, `Backquote`, `Digit5`. */
    code?: string;
    control: boolean;
    shift: boolean;
    alt: boolean;
    meta: boolean;
}

interface Parsed {
    control: boolean;
    shift: boolean;
    alt: boolean;
    meta: boolean;
    key: string;
}

/** An Electron accelerator split into its modifiers and key; `CmdOrCtrl` is Cmd on macOS, Ctrl elsewhere. */
export function parseAccelerator(accelerator: string, mac: boolean): Parsed | undefined {
    const parts = accelerator.split('+');
    // `Ctrl+Plus` names +, and a trailing empty part means the key was `+` itself
    const key = parts.pop();
    if (!key) return undefined;
    const parsed: Parsed = { control: false, shift: false, alt: false, meta: false, key: key.toLowerCase() };
    for (const part of parts.map(p => p.toLowerCase())) {
        if (part === 'cmdorctrl' || part === 'commandorcontrol') parsed[mac ? 'meta' : 'control'] = true;
        else if (part === 'ctrl' || part === 'control') parsed.control = true;
        else if (part === 'cmd' || part === 'command' || part === 'super' || part === 'meta') parsed.meta = true;
        else if (part === 'alt' || part === 'option' || part === 'altgr') parsed.alt = true;
        else if (part === 'shift') parsed.shift = true;
        else return undefined;
    }
    return parsed;
}

/** The names an accelerator may use for the key pressed, from the physical key first (Shift+5 is still `5`). */
function keyNames(input: KeyInput): string[] {
    const names = [input.key.toLowerCase()];
    const code = input.code ?? '';
    if (/^Key[A-Z]$/.test(code)) names.unshift(code.slice(3).toLowerCase());
    else if (/^Digit\d$/.test(code)) names.unshift(code.slice(5));
    else if (/^Numpad\d$/.test(code)) names.unshift(`num${code.slice(6)}`);
    const named: Record<string, string> = {
        Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';',
        Quote: '\'', Comma: ',', Period: '.', Slash: '/', Space: 'space', Tab: 'tab', Enter: 'enter', Escape: 'escape',
        PageUp: 'pageup', PageDown: 'pagedown', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
        Home: 'home', End: 'end', Delete: 'delete', Insert: 'insert', Backspace: 'backspace'
    };
    if (named[code]) names.unshift(named[code]);
    if (/^F\d{1,2}$/.test(code)) names.unshift(code.toLowerCase());
    const aliases: Record<string, string> = { arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right', ' ': 'space', '+': 'plus' };
    return names.flatMap(name => aliases[name] ? [name, aliases[name]] : [name]);
}

export function matches(accelerator: string, input: KeyInput, mac: boolean): boolean {
    const parsed = parseAccelerator(accelerator, mac);
    if (!parsed || input.type !== 'keyDown') return false;
    if (parsed.control !== input.control || parsed.shift !== input.shift || parsed.alt !== input.alt || parsed.meta !== input.meta) return false;
    const key = parsed.key === 'return' ? 'enter' : parsed.key === 'esc' ? 'escape' : parsed.key;
    return keyNames(input).includes(key);
}

/** The skip-shell command that the key press triggers under the bindings, if any. */
export function commandFor(input: KeyInput, bindings: Record<string, string | null>, mac: boolean): string | undefined {
    for (const command of SKIP_SHELL) {
        const accelerator = bindings[command];
        if (accelerator && matches(accelerator, input, mac)) return command;
    }
    return undefined;
}

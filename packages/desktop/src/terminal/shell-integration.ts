import { join } from 'node:path';

/**
 * Shell integration the way VS Code does it: the shell gets a startup script that marks every prompt and command
 * with OSC 633 sequences (`A` prompt start, `B` prompt end, `E;<command line>`, `C` command start, `D;<exit code>`,
 * `P;Cwd=<folder>`). `OscScanner` finds those (and the notifications of OSC 9 and OSC 777) in a terminal's output,
 * `ShellIntegration` turns them into commands with their exit status and working directory.
 */

export type ShellKind = 'bash' | 'zsh' | 'fish';

/** How a terminal's process is started. */
export interface Launch {
    shell: string;
    args: string[];
    env: Record<string, string>;
}

/** The shells with an integration script, by the executable's name (`bash.exe` on Windows counts as bash). */
export function shellKind(shell: string): ShellKind | undefined {
    const name = (shell.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.exe$/, '');
    return name === 'bash' || name === 'zsh' || name === 'fish' ? name : undefined;
}

const LOGIN = new Set(['-l', '--login']);
const INTERACTIVE = new Set(['-i', '--interactive', '-il', '-li']);

/**
 * The launch with the integration script of its shell injected, or the launch as it is (and `injected: false`) when
 * the shell has no script or its arguments do more than ask for a login or interactive shell (`-c`, a script file).
 * `dir` is the folder of the scripts (`scripts/` next to this module once built).
 */
export function injectShellIntegration(launch: Launch, dir: string): Launch & { injected: boolean } {
    const kind = shellKind(launch.shell);
    if (!kind || !launch.args.every(arg => LOGIN.has(arg) || INTERACTIVE.has(arg))) return { ...launch, injected: false };
    const login = launch.args.some(arg => LOGIN.has(arg) || arg === '-il' || arg === '-li');
    const env: Record<string, string> = { ...launch.env, APPLING_SHELL_INTEGRATION: '1' };
    if (kind === 'bash') {
        // --init-file replaces ~/.bashrc and works only for non login shells: the script reads the login files itself
        if (login) env.APPLING_SHELL_LOGIN = '1';
        return { shell: launch.shell, args: ['--init-file', join(dir, 'bash', 'appling.bash'), '-i'], env, injected: true };
    }
    if (kind === 'zsh') {
        // zsh reads its startup files from ZDOTDIR: ours read the user's from where they were, then add the hooks
        env.APPLING_USER_ZDOTDIR = launch.env.ZDOTDIR ?? launch.env.HOME ?? '';
        env.ZDOTDIR = join(dir, 'zsh');
        return { shell: launch.shell, args: login ? ['-l', '-i'] : ['-i'], env, injected: true };
    }
    return { shell: launch.shell, args: [...login ? ['-l'] : [], '-i', '--init-command', `source ${fishQuote(join(dir, 'fish', 'appling.fish'))}`], env, injected: true };
}

function fishQuote(text: string): string {
    return `'${text.replace(/[\\']/g, c => `\\${c}`)}'`;
}

/** An operating system command (`ESC ] code ; data BEL` or `ESC ] code ; data ESC \`). */
export interface Osc {
    code: number;
    data: string;
}

/** The OSC codes the scanner reports: 7 (working directory), 9 (notification, progress), 633 (marks), 777 (notification). */
export const OSC_CODES = new Set([7, 9, 633, 777]);
/** Longer sequences are not marks; they are skipped (an OSC 52 clipboard write or an image may be megabytes). */
const LIMIT = 64 * 1024;

type State = 'text' | 'escape' | 'code' | 'data' | 'dataEscape' | 'skip' | 'skipEscape';

/** Finds OSC sequences in a terminal's output stream; a sequence may be split over any number of chunks. */
export class OscScanner {
    private state: State = 'text';
    private code = '';
    private data = '';

    constructor(private readonly codes: ReadonlySet<number> = OSC_CODES) {}

    /** Whether no sequence is open, so a chunk without ESC holds nothing. */
    get idle(): boolean {
        return this.state === 'text';
    }

    feed(chunk: string): Osc[] {
        const found: Osc[] = [];
        for (let i = 0; i < chunk.length; i++) {
            const c = chunk[i];
            switch (this.state) {
                case 'text':
                    if (c === '\x1b') this.state = 'escape';
                    break;
                case 'escape':
                    if (c === ']') {
                        this.state = 'code';
                        this.code = '';
                    } else if (c !== '\x1b') this.state = 'text';
                    break;
                case 'code':
                    if (c >= '0' && c <= '9' && this.code.length < 6) this.code += c;
                    else if (c === ';' || c === '\x07' || c === '\x1b') {
                        const wanted = this.code !== '' && this.codes.has(Number(this.code));
                        this.data = '';
                        if (c === ';') this.state = wanted ? 'data' : 'skip';
                        else if (c === '\x07') {
                            if (wanted) found.push({ code: Number(this.code), data: '' });
                            this.state = 'text';
                        } else this.state = wanted ? 'dataEscape' : 'skipEscape';
                    } else this.state = c === '\x18' || c === '\x1a' ? 'text' : 'skip';
                    break;
                case 'data': {
                    // copy the run up to the next terminator at once instead of char by char
                    let end = i;
                    while (end < chunk.length && chunk[end] !== '\x07' && chunk[end] !== '\x1b' && chunk[end] !== '\x18' && chunk[end] !== '\x1a') end++;
                    this.data += chunk.slice(i, end);
                    i = end;
                    if (this.data.length > LIMIT) {
                        this.data = '';
                        this.state = 'skip';
                        i--;
                        break;
                    }
                    if (i >= chunk.length) break;
                    const t = chunk[i];
                    if (t === '\x07') {
                        found.push({ code: Number(this.code), data: this.data });
                        this.state = 'text';
                    } else if (t === '\x1b') this.state = 'dataEscape';
                    else this.state = 'text';
                    break;
                }
                case 'dataEscape':
                    if (c === '\\') {
                        found.push({ code: Number(this.code), data: this.data });
                        this.state = 'text';
                    } else {
                        // ESC without a backslash cancels the sequence and starts another one
                        this.state = 'escape';
                        i--;
                    }
                    break;
                case 'skip': {
                    let end = i;
                    while (end < chunk.length && chunk[end] !== '\x07' && chunk[end] !== '\x1b' && chunk[end] !== '\x18' && chunk[end] !== '\x1a') end++;
                    i = end;
                    if (i >= chunk.length) break;
                    this.state = chunk[i] === '\x1b' ? 'skipEscape' : 'text';
                    break;
                }
                case 'skipEscape':
                    if (c === '\\') this.state = 'text';
                    else {
                        this.state = 'escape';
                        i--;
                    }
                    break;
            }
        }
        return found;
    }
}

/** Undoes the escaping of OSC 633 values: `\\` is a backslash and `\xHH` a character (`;` arrives as `\x3b`). */
export function decodeValue(text: string): string {
    return text.replace(/\\(\\|x([0-9a-fA-F]{2}))/g, (_, escape: string, hex?: string) => hex ? String.fromCharCode(parseInt(hex, 16)) : escape);
}

/** A command the shell ran, from its marks. */
export interface CommandRecord {
    /** The command line as typed; missing when the shell could not report it. */
    command?: string;
    /** The working directory when it started. */
    cwd?: string;
    /** Missing while it runs and when the shell did not report one. */
    exitCode?: number;
    /** Milliseconds since the epoch. */
    started: number;
    ended?: number;
}

export interface Notification {
    /** Missing for OSC 9, which has only a body. */
    title?: string;
    body: string;
    source: 'osc9' | 'osc777';
}

export type IntegrationEvent =
    | { type: 'prompt' }
    | { type: 'commandStarted', command: CommandRecord }
    | { type: 'commandFinished', command: CommandRecord }
    | { type: 'cwd', cwd: string }
    | { type: 'notification', notification: Notification }
    /** ConEmu's OSC 9;4: 0 clears, 1 sets the value, 2 is an error, 3 indeterminate, 4 paused. */
    | { type: 'progress', state: number, value?: number };

/** Commands kept per terminal; older ones are dropped. */
const HISTORY = 500;

/** The shell integration state of one terminal: its commands, the running one and the working directory. */
export class ShellIntegration {
    private readonly scanner = new OscScanner();
    /** Whether the shell sent any OSC 633 mark, so its commands are known. */
    active = false;
    cwd?: string;
    readonly commands: CommandRecord[] = [];
    running?: CommandRecord;
    private commandLine?: string;

    constructor(cwd?: string) {
        this.cwd = cwd;
    }

    /** The events in a chunk of the terminal's output. */
    feed(chunk: string, now = Date.now()): IntegrationEvent[] {
        if (this.scanner.idle && !chunk.includes('\x1b')) return [];
        return this.scanner.feed(chunk).flatMap(osc => this.handle(osc, now));
    }

    handle(osc: Osc, now = Date.now()): IntegrationEvent[] {
        if (osc.code === 633) return this.mark(osc.data, now);
        if (osc.code === 7) {
            const cwd = fileUrlPath(osc.data);
            return cwd ? this.setCwd(cwd) : [];
        }
        if (osc.code === 9) {
            const progress = /^4;(\d)(?:;(\d{1,3}))?$/.exec(osc.data);
            if (progress) return [{ type: 'progress', state: Number(progress[1]), ...progress[2] !== undefined ? { value: Number(progress[2]) } : {} }];
            // ConEmu's 9;9 sets the working directory (Windows Terminal reads it too)
            const cwd = /^9;"?([^"]*)"?$/.exec(osc.data);
            if (cwd) return this.setCwd(cwd[1]);
            if (/^\d+;/.test(osc.data) || !osc.data) return [];
            return [{ type: 'notification', notification: { body: osc.data, source: 'osc9' } }];
        }
        if (osc.code === 777) {
            const [kind, title, ...body] = osc.data.split(';');
            if (kind !== 'notify') return [];
            return [{ type: 'notification', notification: { title, body: body.join(';'), source: 'osc777' } }];
        }
        return [];
    }

    private mark(data: string, now: number): IntegrationEvent[] {
        this.active = true;
        const [kind, ...rest] = data.split(';');
        switch (kind) {
            case 'A':
                return [{ type: 'prompt' }];
            case 'E':
                this.commandLine = decodeValue(rest[0] ?? '');
                return [];
            case 'C': {
                const events: IntegrationEvent[] = this.running ? this.finish(undefined, now) : [];
                this.running = { ...this.commandLine !== undefined ? { command: this.commandLine } : {}, ...this.cwd ? { cwd: this.cwd } : {}, started: now };
                this.commandLine = undefined;
                return [...events, { type: 'commandStarted', command: this.running }];
            }
            case 'D': {
                if (!this.running) return [];
                const code = rest[0] !== undefined && /^-?\d+$/.test(rest[0]) ? Number(rest[0]) : undefined;
                return this.finish(code, now);
            }
            case 'P': {
                const value = rest.join(';');
                if (value.startsWith('Cwd=')) return this.setCwd(decodeValue(value.slice(4)));
                return [];
            }
            default:
                return [];
        }
    }

    private finish(exitCode: number | undefined, now: number): IntegrationEvent[] {
        const command = this.running!;
        this.running = undefined;
        if (exitCode !== undefined) command.exitCode = exitCode;
        command.ended = now;
        this.commands.push(command);
        if (this.commands.length > HISTORY) this.commands.splice(0, this.commands.length - HISTORY);
        return [{ type: 'commandFinished', command }];
    }

    private setCwd(cwd: string): IntegrationEvent[] {
        if (!cwd || cwd === this.cwd) return [];
        this.cwd = cwd;
        return [{ type: 'cwd', cwd }];
    }
}

/** The path of a `file://host/path` URL as OSC 7 sends it. */
function fileUrlPath(text: string): string | undefined {
    try {
        const url = new URL(text);
        if (url.protocol !== 'file:') return undefined;
        const path = decodeURIComponent(url.pathname);
        // file:///C:/work on Windows
        return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
    } catch {
        return undefined;
    }
}

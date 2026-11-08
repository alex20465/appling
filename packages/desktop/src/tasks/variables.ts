import { basename } from 'node:path';
import { argValue, type Platform, type TaskDefinition } from './definitions.js';

/**
 * VS Code's variables in task strings (`${workspaceFolder}`, `${env:HOME}`, `${input:version}`, ...) and how a task
 * becomes the program a terminal runs. Pure.
 */

export interface VariableContext {
    /** The repo the task runs in. */
    workspaceFolder: string;
    /** The folders of its workspace by name, for `${workspaceFolder:name}`. */
    folders?: Record<string, string>;
    env: Record<string, string | undefined>;
    userHome: string;
    platform: Platform;
    /** Values of `${input:id}`, asked for before the run. */
    inputs?: Record<string, string>;
    /** Values of `${config:key}`, from the settings files. */
    config?: Record<string, unknown>;
}

const VARIABLE = /\$\{([^}]+)\}/g;

/** Replaces the variables of one string; `problems` collects the ones it cannot fill, which become empty. */
export function resolveVariables(text: string, context: VariableContext, problems: string[] = []): string {
    return text.replace(VARIABLE, (whole, name: string) => {
        const value = variable(name, context);
        if (value === undefined) {
            if (!problems.includes(whole)) problems.push(whole);
            return '';
        }
        return value;
    });
}

function variable(name: string, context: VariableContext): string | undefined {
    const separator = context.platform === 'win32' ? '\\' : '/';
    switch (name) {
        case 'workspaceFolder':
        case 'workspaceRoot':
        case 'cwd':
            return context.workspaceFolder;
        case 'workspaceFolderBasename':
            return basename(context.workspaceFolder);
        case 'userHome':
            return context.userHome;
        case 'pathSeparator':
        case '/':
            return separator;
    }
    const colon = name.indexOf(':');
    if (colon < 0) return undefined;
    const kind = name.slice(0, colon), key = name.slice(colon + 1);
    if (kind === 'env') return context.env[key] ?? '';
    if (kind === 'input') return context.inputs?.[key];
    if (kind === 'workspaceFolder') return context.folders?.[key];
    if (kind === 'config') {
        const value = context.config?.[key];
        return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined;
    }
    return undefined;
}

/** The `${input:id}` names a task uses, in order of appearance. */
export function inputsUsed(task: TaskDefinition): string[] {
    const strings = [task.command ?? '', ...task.args.map(argValue), task.cwd ?? '', ...Object.values(task.env), task.shell?.executable ?? '', ...task.shell?.args ?? []];
    const used: string[] = [];
    for (const text of strings) {
        for (const match of text.matchAll(VARIABLE)) {
            if (match[1].startsWith('input:') && !used.includes(match[1].slice(6))) used.push(match[1].slice(6));
        }
    }
    return used;
}

/** What a terminal runs for a task: a program with its arguments, its working directory and extra environment. */
export interface TaskLaunch {
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    /** The command line as typed, for the task list. */
    line: string;
}

/**
 * Resolves a task's variables and builds its launch. A `process` task runs its command with its arguments; a `shell`
 * task runs one command line through the shell (`options.shell`, else `$SHELL -c` or `cmd.exe /d /c`), its arguments
 * quoted as VS Code does. Throws for a task without a command (it only has dependencies).
 */
export function taskLaunch(task: TaskDefinition, context: VariableContext, problems: string[] = []): TaskLaunch {
    if (!task.command) throw new Error(`Task "${task.label}" has no command.`);
    const resolve = (text: string) => resolveVariables(text, context, problems);
    const command = resolve(task.command);
    const args = task.args.map(arg => typeof arg === 'string' ? resolve(arg) : { ...arg, value: resolve(arg.value) });
    const cwd = task.cwd ? resolve(task.cwd) : context.workspaceFolder;
    const env = Object.fromEntries(Object.entries(task.env).map(([key, value]) => [key, resolve(value)]));
    if (task.type === 'process') {
        const plain = args.map(argValue);
        return { command, args: plain, cwd, env, line: [command, ...plain].map(a => quote(a, 'weak', 'posix')).join(' ') };
    }
    const executable = task.shell?.executable ? resolve(task.shell.executable) : defaultShell(context);
    const kind = shellKind(executable);
    const line = [args.length && /\s/.test(command) ? quote(command, 'weak', kind) : command, ...args.map(arg => typeof arg === 'string' ? quote(arg, undefined, kind) : quote(arg.value, arg.quoting, kind))].join(' ');
    const shellArgs = task.shell?.args?.map(resolve) ?? (kind === 'cmd' ? ['/d', '/c'] : kind === 'powershell' ? ['-Command'] : ['-c']);
    return { command: executable, args: [...shellArgs, line], cwd, env, line };
}

function defaultShell(context: VariableContext): string {
    if (context.platform === 'win32') return context.env.ComSpec ?? context.env.COMSPEC ?? 'cmd.exe';
    return context.env.SHELL || '/bin/sh';
}

export type ShellKind = 'posix' | 'cmd' | 'powershell';

export function shellKind(executable: string): ShellKind {
    const name = basename(executable.replace(/\\/g, '/')).toLowerCase().replace(/\.exe$/, '');
    return name === 'cmd' ? 'cmd' : name === 'pwsh' || name === 'powershell' ? 'powershell' : 'posix';
}

/**
 * Quotes one argument for a shell's command line. Without a quoting it is left alone unless it holds whitespace or
 * characters the shell would read, then quoted strongly (`'…'`) in a POSIX shell and weakly (`"…"`) elsewhere.
 */
export function quote(value: string, quoting: 'escape' | 'strong' | 'weak' | undefined, kind: ShellKind): string {
    if (!quoting) {
        if (value !== '' && !/[\s'"`$\\&|;<>()*?#~!{}[\]^%]/.test(value)) return value;
        quoting = kind === 'posix' ? 'strong' : 'weak';
    }
    if (quoting === 'escape') {
        if (kind === 'cmd') return value.replace(/([\s&|<>^()%!"])/g, '^$1');
        if (kind === 'powershell') return value.replace(/([\s`'"$&|;<>(){}])/g, '`$1');
        return value.replace(/([\s'"`$\\&|;<>()*?#~!{}[\]])/g, '\\$1');
    }
    if (quoting === 'strong') {
        if (kind === 'posix') return `'${value.replace(/'/g, `'\\''`)}'`;
        if (kind === 'powershell') return `'${value.replace(/'/g, "''")}'`;
        return `"${value.replace(/"/g, '""')}"`;
    }
    if (kind === 'posix') return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
    if (kind === 'powershell') return `"${value.replace(/(["`$])/g, '`$1')}"`;
    return `"${value.replace(/"/g, '""')}"`;
}


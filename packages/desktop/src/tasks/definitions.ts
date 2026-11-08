import { stripJsonc } from '../code-workspace.js';

/**
 * VS Code's tasks (`.vscode/tasks.json`, version 2, and the `tasks` section of a `.code-workspace` file), read into
 * plain definitions: the platform overrides and the file's global properties applied, every list and shorthand
 * normalized. Pure; variables stay in the strings until `variables.ts` resolves them at run time.
 */

export type Platform = 'linux' | 'darwin' | 'win32';

/** Where a task comes from. */
export type TaskSource = 'folder' | 'workspace' | 'appling';

/** An argument as VS Code takes it: a string, or a value with how a shell quotes it. */
export type TaskArg = string | { value: string, quoting?: 'escape' | 'strong' | 'weak' };

export interface ShellOptions {
    executable?: string;
    args?: string[];
}

export interface BackgroundPatterns {
    /** Whether the task is busy from its start, before a begin pattern matched (VS Code's `activeAtBeginning`). */
    activeAtBeginning: boolean;
    /** A line matching one starts a busy phase; one matching an end pattern makes the task ready. */
    begins: string[];
    ends: string[];
}

export interface TaskPresentation {
    /** Whether running the task shows its terminal: `always` (the default), `silent` (only when it fails) or `never`. */
    reveal: 'always' | 'silent' | 'never';
    /** Closes the task's terminal when the task ends. */
    close: boolean;
}

/** A `promptString` or `pickString` input (`${input:id}`), asked for before the task runs. */
export interface TaskInput {
    id: string;
    type: 'promptString' | 'pickString';
    description?: string;
    default?: string;
    /** The choices of a `pickString`. */
    options?: string[];
    /** Whether a `promptString` input may be empty; false for built in inputs that need a value. */
    allowEmpty?: boolean;
}

export interface TaskDefinition {
    label: string;
    source: TaskSource;
    /** `shell` runs the command line through a shell, `process` the executable itself; a task without a command only runs its dependencies. */
    type: 'shell' | 'process';
    command?: string;
    args: TaskArg[];
    cwd?: string;
    env: Record<string, string>;
    shell?: ShellOptions;
    dependsOn: string[];
    dependsOrder: 'parallel' | 'sequence';
    isBackground: boolean;
    /** How a background task tells it is ready; without patterns it counts as ready once it started. */
    background?: BackgroundPatterns;
    runOn: 'default' | 'folderOpen';
    presentation: TaskPresentation;
    group?: { kind: string, isDefault: boolean };
    detail?: string;
    /** Left out of the "Run Task" pick (`hide`), still runnable as a dependency. */
    hide: boolean;
}

export interface TaskFile {
    tasks: TaskDefinition[];
    inputs: TaskInput[];
    problems: string[];
}

const PLATFORM_KEY: Record<Platform, 'linux' | 'osx' | 'windows'> = { linux: 'linux', darwin: 'osx', win32: 'windows' };

/**
 * Background patterns of VS Code's problem matchers that tell when a watcher is ready, by name. Other named matchers
 * have no background part; a background task using only those is ready as soon as it starts.
 */
export const KNOWN_BACKGROUND: Record<string, Omit<BackgroundPatterns, 'activeAtBeginning'>> = {
    '$tsc-watch': {
        begins: ['^\\s*(?:message TS6032:|\\[?\\D*\\d{1,2}[:.]\\d{1,2}[:.]\\d{1,2}\\D*(?:├\\D*\\d{1,2}\\D+┤)?(?:\\]| -)) (?:Starting compilation in watch mode|File change detected\\. Starting incremental compilation)\\.\\.\\.'],
        ends: ['^\\s*(?:message TS6042:|\\[?\\D*\\d{1,2}[:.]\\d{1,2}[:.]\\d{1,2}\\D*(?:├\\D*\\d{1,2}\\D+┤)?(?:\\]| -)) (?:Compilation complete\\.|Found \\d+ errors?\\.) Watching for file changes\\.']
    },
    // from the esbuild problem matchers extension
    '$esbuild-watch': { begins: ['^\\[watch\\] build started'], ends: ['^\\[watch\\] build finished'] }
};

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);

/** Parses a `tasks.json` text. Problems name what was skipped; a text that is not JSON(C) has no tasks. */
export function parseTasksJson(text: string, platform: Platform, source: TaskSource = 'folder'): TaskFile {
    let json: unknown;
    try {
        json = JSON.parse(stripJsonc(text));
    } catch (error) {
        return { tasks: [], inputs: [], problems: [`tasks.json is not valid JSON: ${(error as Error).message}`] };
    }
    return readTasks(json, platform, source);
}

/** Reads the tasks of a parsed `tasks.json`, or of a workspace file's `tasks` section. */
export function readTasks(json: unknown, platform: Platform, source: TaskSource): TaskFile {
    const problems: string[] = [];
    if (!isObject(json)) return { tasks: [], inputs: [], problems: ['The tasks file holds no object.'] };
    if (json.version !== undefined && json.version !== '2.0.0') problems.push(`Version ${String(json.version)} of tasks.json is not supported; it is read as version 2.0.0.`);
    // the file's own properties (command, options, ...) are defaults for every task, its platform section over them
    const globals = overlay(pick(json, GLOBAL_KEYS), isObject(json[PLATFORM_KEY[platform]]) ? pick(json[PLATFORM_KEY[platform]] as Json, GLOBAL_KEYS) : {});
    const tasks: TaskDefinition[] = [];
    const labels = new Set<string>();
    for (const [index, raw] of (Array.isArray(json.tasks) ? json.tasks : []).entries()) {
        if (!isObject(raw)) {
            problems.push(`Task ${index + 1} is not an object.`);
            continue;
        }
        const merged = overlay(overlay(globals, raw), isObject(raw[PLATFORM_KEY[platform]]) ? raw[PLATFORM_KEY[platform]] as Json : {});
        const task = readTask(merged, source, problems, index);
        if (!task) continue;
        if (labels.has(task.label)) {
            problems.push(`There are two tasks labelled "${task.label}"; the first one counts.`);
            continue;
        }
        labels.add(task.label);
        tasks.push(task);
    }
    const inputs: TaskInput[] = [];
    for (const raw of Array.isArray(json.inputs) ? json.inputs : []) {
        if (!isObject(raw) || typeof raw.id !== 'string') continue;
        if (raw.type !== 'promptString' && raw.type !== 'pickString') {
            problems.push(`Input "${raw.id}" has type ${String(raw.type)}; only promptString and pickString are supported.`);
            continue;
        }
        const options = raw.type === 'pickString' && Array.isArray(raw.options)
            ? raw.options.map(o => typeof o === 'string' ? o : isObject(o) && typeof o.value === 'string' ? o.value : undefined).filter((o): o is string => o !== undefined)
            : undefined;
        inputs.push({
            id: raw.id, type: raw.type,
            ...typeof raw.description === 'string' ? { description: raw.description } : {},
            ...typeof raw.default === 'string' ? { default: raw.default } : {},
            ...options ? { options } : {}
        });
    }
    return { tasks, inputs, problems };
}

const GLOBAL_KEYS = ['type', 'command', 'args', 'options', 'isBackground', 'problemMatcher', 'presentation'];

function pick(json: Json, keys: string[]): Json {
    return Object.fromEntries(keys.filter(key => json[key] !== undefined).map(key => [key, json[key]]));
}

/** `over` replaces `base` key by key; `options` (with its `env` and `shell`) and `presentation` merge one level deeper, as in VS Code. */
function overlay(base: Json, over: Json): Json {
    const result: Json = { ...base, ...over };
    for (const key of ['options', 'presentation']) {
        if (isObject(base[key]) && isObject(over[key])) {
            const merged: Json = { ...base[key] as Json, ...over[key] as Json };
            if (key === 'options') {
                for (const inner of ['env', 'shell']) {
                    const a = (base[key] as Json)[inner], b = (over[key] as Json)[inner];
                    if (isObject(a) && isObject(b)) merged[inner] = { ...a, ...b };
                }
            }
            result[key] = merged;
        }
    }
    return result;
}

function readTask(raw: Json, source: TaskSource, problems: string[], index: number): TaskDefinition | undefined {
    const type = raw.type ?? 'process';
    const npm = type === 'npm' && typeof raw.script === 'string';
    const label = typeof raw.label === 'string' ? raw.label
        : typeof raw.taskName === 'string' ? raw.taskName
        : npm ? `npm: ${raw.script as string}` : undefined;
    if (!label) {
        problems.push(`Task ${index + 1} has no label.`);
        return undefined;
    }
    if (type !== 'shell' && type !== 'process' && !npm) {
        problems.push(`Task "${label}" has type ${String(type)}, which only VS Code's extensions run; it is skipped.`);
        return undefined;
    }
    const dependsOn = (typeof raw.dependsOn === 'string' ? [raw.dependsOn] : Array.isArray(raw.dependsOn) ? raw.dependsOn : [])
        .map(d => typeof d === 'string' ? d : isObject(d) && typeof d.label === 'string' ? d.label : undefined);
    if (dependsOn.includes(undefined)) problems.push(`Task "${label}" depends on a task given by type, which is not supported; that dependency is left out.`);
    let command = npm ? 'npm' : typeof raw.command === 'string' ? raw.command : undefined;
    let args: TaskArg[] = npm ? ['run', raw.script as string] : readArgs(raw.args);
    // VS Code takes a command given as a list as the command and its first arguments
    if (Array.isArray(raw.command)) {
        const parts = readArgs(raw.command);
        command = parts.length ? argValue(parts[0]) : undefined;
        args = [...parts.slice(1), ...args];
    }
    if (!command && !dependsOn.length) {
        problems.push(`Task "${label}" has neither a command nor dependencies.`);
        return undefined;
    }
    const options = isObject(raw.options) ? raw.options : {};
    const env = isObject(options.env) ? Object.fromEntries(Object.entries(options.env).filter(([, v]) => typeof v === 'string')) as Record<string, string> : {};
    const shell = isObject(options.shell) ? {
        ...typeof options.shell.executable === 'string' ? { executable: options.shell.executable } : {},
        ...Array.isArray(options.shell.args) ? { args: options.shell.args.filter((a): a is string => typeof a === 'string') } : {}
    } : undefined;
    const isBackground = raw.isBackground === true;
    const background = isBackground ? backgroundPatterns(raw.problemMatcher, label, problems) : undefined;
    const presentation = isObject(raw.presentation) ? raw.presentation : {};
    const runOptions = isObject(raw.runOptions) ? raw.runOptions : {};
    const group = typeof raw.group === 'string' ? { kind: raw.group, isDefault: false }
        : isObject(raw.group) && typeof raw.group.kind === 'string' ? { kind: raw.group.kind, isDefault: raw.group.isDefault === true || typeof raw.group.isDefault === 'string' } : undefined;
    return {
        label, source,
        type: npm ? 'shell' : type as 'shell' | 'process',
        ...command ? { command } : {},
        args,
        ...typeof options.cwd === 'string' ? { cwd: options.cwd } : npm && typeof raw.path === 'string' ? { cwd: `\${workspaceFolder}/${raw.path}` } : {},
        env,
        ...shell ? { shell } : {},
        dependsOn: dependsOn.filter((d): d is string => d !== undefined),
        dependsOrder: raw.dependsOrder === 'sequence' ? 'sequence' : 'parallel',
        isBackground,
        ...background ? { background } : {},
        runOn: runOptions.runOn === 'folderOpen' ? 'folderOpen' : 'default',
        presentation: {
            reveal: presentation.reveal === 'never' || presentation.reveal === 'silent' ? presentation.reveal : 'always',
            close: presentation.close === true
        },
        ...group ? { group } : {},
        ...typeof raw.detail === 'string' ? { detail: raw.detail } : {},
        hide: raw.hide === true
    };
}

function readArgs(value: unknown): TaskArg[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((arg): TaskArg[] => {
        if (typeof arg === 'string') return [arg];
        if (isObject(arg) && (typeof arg.value === 'string' || Array.isArray(arg.value))) {
            const quoting = arg.quoting === 'escape' || arg.quoting === 'strong' || arg.quoting === 'weak' ? arg.quoting : undefined;
            const values = Array.isArray(arg.value) ? arg.value.filter((v): v is string => typeof v === 'string') : [arg.value as string];
            return values.map(v => quoting ? { value: v, quoting } : v);
        }
        return [];
    });
}

export function argValue(arg: TaskArg): string {
    return typeof arg === 'string' ? arg : arg.value;
}

/** The background patterns of a task's problem matchers (named, objects, or a list of both). */
function backgroundPatterns(matcher: unknown, label: string, problems: string[]): BackgroundPatterns | undefined {
    const begins: string[] = [], ends: string[] = [];
    let activeAtBeginning = false;
    for (const one of Array.isArray(matcher) ? matcher : matcher === undefined ? [] : [matcher]) {
        if (typeof one === 'string') {
            const known = KNOWN_BACKGROUND[one];
            if (known) {
                begins.push(...known.begins);
                ends.push(...known.ends);
                activeAtBeginning = true;
            }
            continue;
        }
        if (!isObject(one)) continue;
        const base = typeof one.base === 'string' ? KNOWN_BACKGROUND[one.base] : undefined;
        const watching = isObject(one.background) ? one.background : isObject(one.watching) ? one.watching : undefined;
        if (!watching && base) {
            begins.push(...base.begins);
            ends.push(...base.ends);
            activeAtBeginning = true;
            continue;
        }
        if (!watching) continue;
        const pattern = (value: unknown) => typeof value === 'string' ? value : isObject(value) && typeof value.regexp === 'string' ? value.regexp : undefined;
        const begin = pattern(watching.beginsPattern), end = pattern(watching.endsPattern);
        for (const [list, value] of [[begins, begin], [ends, end]] as const) {
            if (value === undefined) continue;
            try {
                new RegExp(value);
                list.push(value);
            } catch {
                problems.push(`Task "${label}" has an invalid background pattern: ${value}`);
            }
        }
        if (watching.activeAtBeginning === true) activeAtBeginning = true;
    }
    return ends.length ? { activeAtBeginning, begins, ends } : undefined;
}

/**
 * The tasks a repo offers: its own (`.vscode/tasks.json`), then those of its workspace files and the built in ones
 * whose label no earlier one has. Inputs are looked up the same way.
 */
export function combineTasks(...files: TaskFile[]): TaskFile {
    const tasks: TaskDefinition[] = [];
    const inputs: TaskInput[] = [];
    const problems: string[] = [];
    for (const file of files) {
        for (const task of file.tasks) if (!tasks.some(t => t.label === task.label)) tasks.push(task);
        for (const input of file.inputs) if (!inputs.some(i => i.id === input.id)) inputs.push(input);
        problems.push(...file.problems);
    }
    return { tasks, inputs, problems };
}

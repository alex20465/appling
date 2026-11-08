import { resolve } from 'node:path';
import type { RailContribution } from '../rail-status.js';
import type { BackgroundPatterns } from './definitions.js';

/**
 * The state of a task (pure): waiting for its dependencies, running, then succeeded or failed by its exit code, or
 * stopped by the user. A background task stays running; `ready` tells whether its watcher finished a round (its
 * problem matcher's end pattern matched after the last begin pattern).
 */

export type TaskStatus = 'idle' | 'waiting' | 'running' | 'succeeded' | 'failed' | 'stopped';

export interface TaskState {
    status: TaskStatus;
    background: boolean;
    /** For a running background task: whether it is ready. */
    ready?: boolean;
    /** The terminal the task runs (or ran) in. */
    terminal?: string;
    exit?: { code: number, signal?: number };
    /** Why it failed or stopped, for the task list. */
    reason?: string;
    started?: number;
    ended?: number;
}

export type TaskEvent =
    | { type: 'wait' }
    | { type: 'start', terminal?: string, background: boolean, ready: boolean }
    | { type: 'begin' }
    | { type: 'end' }
    | { type: 'exit', code: number, signal?: number }
    | { type: 'stop' }
    | { type: 'fail', reason: string }
    /** The terminal is gone without an exit status (the pty host ended). */
    | { type: 'lost' }
    /** A task with only dependencies finished them. */
    | { type: 'done' };

export const IDLE: TaskState = { status: 'idle', background: false };

export function isActive(state: TaskState | undefined): boolean {
    return state?.status === 'waiting' || state?.status === 'running';
}

export function transition(state: TaskState, event: TaskEvent, now = Date.now()): TaskState {
    switch (event.type) {
        case 'wait':
            return { status: 'waiting', background: state.background, started: now };
        case 'start':
            return {
                status: 'running', background: event.background, started: state.status === 'waiting' ? state.started ?? now : now,
                ...event.terminal ? { terminal: event.terminal } : {},
                ...event.background ? { ready: event.ready } : {}
            };
        case 'begin':
        case 'end':
            if (state.status !== 'running' || !state.background) return state;
            return { ...state, ready: event.type === 'end' };
        case 'exit': {
            if (state.status !== 'running') return state;
            const { ready: _, ...rest } = state;
            const exit = { code: event.code, ...event.signal ? { signal: event.signal } : {} };
            return event.code === 0
                ? { ...rest, status: 'succeeded', exit, ended: now }
                : { ...rest, status: 'failed', exit, reason: event.signal ? `ended by signal ${event.signal}` : `exited with code ${event.code}`, ended: now };
        }
        case 'stop':
        case 'lost': {
            if (!isActive(state)) return state;
            const { ready: _, ...rest } = state;
            return { ...rest, status: 'stopped', ended: now, ...event.type === 'lost' ? { reason: 'its terminal is gone' } : {} };
        }
        case 'fail': {
            const { ready: _, ...rest } = state;
            return { ...rest, status: 'failed', reason: event.reason, ended: now };
        }
        case 'done':
            return isActive(state) ? { status: 'succeeded', background: false, ...state.started ? { started: state.started } : {}, ended: now } : state;
    }
}

/** What a task's dependents wait for: its exit, or a background task's first ready. */
export function settled(state: TaskState): boolean {
    return !isActive(state) || (state.status === 'running' && state.background && state.ready === true);
}

/** `\x1b[…m` and other escape sequences, so patterns see the text a user sees. */
const ESCAPES = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][^\x1b]*\x1b\\|[@-Z\\-_])/g;

export function stripEscapes(text: string): string {
    return text.replace(ESCAPES, '');
}

/**
 * Watches a background task's output line by line for its begin and end patterns. Lines are split at `\n` and `\r`,
 * so progress output that redraws one line still counts.
 */
export class BackgroundMatcher {
    private readonly begins: RegExp[];
    private readonly ends: RegExp[];
    private partial = '';

    constructor(patterns: BackgroundPatterns) {
        this.begins = patterns.begins.map(p => new RegExp(p));
        this.ends = patterns.ends.map(p => new RegExp(p));
    }

    /** The events of the complete lines in a chunk of output, in order. */
    feed(chunk: string): ('begin' | 'end')[] {
        const lines = (this.partial + stripEscapes(chunk)).split(/\r\n|\r|\n/);
        this.partial = lines.pop() ?? '';
        if (this.partial.length > 4096) this.partial = this.partial.slice(-4096);
        return lines.flatMap(line => this.match(line));
    }

    /** Whether a whole text (a terminal's scrollback) ends ready: the last match is an end pattern. */
    readyIn(text: string): boolean | undefined {
        const events = stripEscapes(text).split(/\r\n|\r|\n/).flatMap(line => this.match(line));
        return events.length ? events.at(-1) === 'end' : undefined;
    }

    private match(line: string): ('begin' | 'end')[] {
        // a line can end one round and begin the next; the end of a line wins
        const begin = this.begins.some(p => p.test(line)), end = this.ends.some(p => p.test(line));
        return [...begin ? ['begin' as const] : [], ...end ? ['end' as const] : []];
    }
}

/**
 * What a background task is at its start: busy until its end pattern matches when it has patterns, else ready (it
 * cannot tell, as in VS Code).
 */
export function readyAtStart(patterns: BackgroundPatterns | undefined): boolean {
    return !patterns;
}

/** The task source of the rail: per repo the running (also waiting and background) and the failed tasks. */
export function taskContributions(repos: ReadonlyMap<string, Readonly<Record<string, TaskState>>>): Map<string, RailContribution> {
    const result = new Map<string, RailContribution>();
    for (const [repo, tasks] of repos) {
        let running = 0, failed = 0;
        const notes: string[] = [];
        for (const [label, state] of Object.entries(tasks)) {
            if (isActive(state)) {
                running++;
                notes.push(`Task ${state.status === 'waiting' ? 'waiting' : 'running'}: ${label}${state.background ? state.ready ? ' (ready)' : ' (starting)' : ''}`);
            } else if (state.status === 'failed') {
                failed++;
                notes.push(`Task failed: ${label}${state.reason ? `, ${state.reason}` : ''}`);
            }
        }
        if (running || failed) result.set(resolve(repo), { counts: { tasksRunning: running, tasksFailed: failed }, notes });
    }
    return result;
}

/** Whether automatic tasks (`runOn: folderOpen`) may run in a folder: asked once, then kept. */
export type AutomaticTasks = 'allow' | 'deny';

/** What the runner keeps between starts (`tasks.json` in the user data folder). */
export interface TaskStoreData {
    repos: Record<string, { automatic?: AutomaticTasks, tasks: Record<string, TaskState> }>;
}

const STATUSES: readonly TaskStatus[] = ['idle', 'waiting', 'running', 'succeeded', 'failed', 'stopped'];

/** Reads the stored data, dropping what does not fit. */
export function readTaskStore(data: unknown): TaskStoreData {
    const repos: TaskStoreData['repos'] = {};
    const raw = (data as TaskStoreData | undefined)?.repos;
    if (!raw || typeof raw !== 'object') return { repos };
    for (const [repo, value] of Object.entries(raw)) {
        if (!value || typeof value !== 'object') continue;
        const tasks: Record<string, TaskState> = {};
        for (const [label, state] of Object.entries(value.tasks ?? {})) {
            if (!state || typeof state !== 'object' || !STATUSES.includes(state.status)) continue;
            tasks[label] = {
                status: state.status, background: state.background === true,
                ...typeof state.ready === 'boolean' ? { ready: state.ready } : {},
                ...typeof state.terminal === 'string' ? { terminal: state.terminal } : {},
                ...state.exit && typeof state.exit.code === 'number' ? { exit: state.exit } : {},
                ...typeof state.reason === 'string' ? { reason: state.reason } : {},
                ...typeof state.started === 'number' ? { started: state.started } : {},
                ...typeof state.ended === 'number' ? { ended: state.ended } : {}
            };
        }
        repos[repo] = { ...value.automatic === 'allow' || value.automatic === 'deny' ? { automatic: value.automatic } : {}, tasks };
    }
    return { repos };
}

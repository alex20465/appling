import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { readCodeWorkspace } from '../code-workspace.js';
import type { TerminalService } from '../terminal/service.js';
import { builtinTasks, type ApplingCli } from './builtin.js';
import { combineTasks, parseTasksJson, readTasks, type Platform, type TaskDefinition, type TaskFile, type TaskInput } from './definitions.js';
import { dependencyPlan, executePlan, planLabels, type StepResult } from './plan.js';
import { BackgroundMatcher, IDLE, isActive, readTaskStore, readyAtStart, settled, transition, type AutomaticTasks, type TaskEvent, type TaskState, type TaskStoreData } from './state.js';
import { inputsUsed, taskLaunch, type VariableContext } from './variables.js';

export interface TaskRunnerOptions {
    /** Where the task states and the automatic tasks decisions are kept between starts; in memory only when left out. */
    storeFile?: string;
    platform?: Platform;
    /** The environment variables resolve against (`${env:X}`); this process's by default. */
    env?: Record<string, string | undefined>;
    userHome?: string;
    /** The `.code-workspace` files holding the repo, for their `tasks` section. */
    workspaceFiles?(repo: string): string[];
    /** The folders of the repo's workspaces by name, for `${workspaceFolder:name}`. */
    folders?(repo: string): Record<string, string>;
    /** How to run `appling` in the repo; no built in tasks without it. */
    cli?(repo: string): ApplingCli | undefined;
    /** Asks whether the repo's automatic tasks may run; undefined leaves the question for the next open. */
    askAutomatic?(repo: string, labels: string[]): Promise<AutomaticTasks | undefined>;
    /** Shows a task's terminal (presentation `reveal`). */
    reveal?(repo: string, terminal: string): void;
    /** How long a stopped task gets after SIGTERM before SIGKILL. */
    killAfter?: number;
}

export interface RunOptions {
    /** Values of the task's inputs (`${input:id}`), by id. */
    inputs?: Record<string, string>;
    /** Started by the user, so its terminal is revealed as its presentation says; automatic runs stay in the background. */
    manual?: boolean;
}

/** A task as the task list shows it. */
export interface TaskItem {
    label: string;
    source: TaskDefinition['source'] | 'gone';
    detail?: string;
    group?: string;
    background: boolean;
    automatic: boolean;
    hidden: boolean;
    /** The inputs a run asks for first (also those of its dependencies). */
    inputs: TaskInput[];
    state: TaskState;
}

/** The terminal a task runs in, with what watches its output. */
interface Route {
    repo: string;
    label: string;
    matcher?: BackgroundMatcher;
    /** The scrollback seen at a reattach before the task's definition was known. */
    scrollback?: string;
}

type Events = { changed: [repo: string] };

/**
 * Runs the tasks of each repo (`.vscode/tasks.json`, its workspace files' `tasks`, the built in `appling` tasks), each
 * in its own terminal of the `TerminalService`, so they live in the pty host and outlive the app. Follows each task's
 * state from its terminal (exit code, background patterns), keeps the states and the terminals they run in so a
 * restart finds them again, and starts the `folderOpen` tasks of a repo once the user allowed it. Electron free.
 */
export class TaskRunner extends EventEmitter<Events> {
    private readonly store: TaskStoreData;
    private readonly routes = new Map<string, Route>();
    private readonly opened = new Set<string>();
    private readonly platform: Platform;

    constructor(private readonly service: TerminalService, private readonly options: TaskRunnerOptions = {}) {
        super();
        this.platform = options.platform ?? process.platform as Platform;
        this.store = readTaskStore(options.storeFile && existsSync(options.storeFile) ? safeJson(readFileSync(options.storeFile, 'utf8')) : undefined);
        // the terminals of tasks run programs; after a restart they keep their tab when they end
        for (const [repo, entry] of Object.entries(this.store.repos)) {
            for (const [label, state] of Object.entries(entry.tasks)) {
                if (!state.terminal) continue;
                service.programs.add(state.terminal);
                this.routes.set(state.terminal, { repo, label });
            }
        }
        service.on('data', (id, data) => this.output(id, data));
        service.on('exit', (id, exit) => this.exited(id, exit));
        service.on('attached', (id, scrollback) => this.reattached(id, scrollback));
    }

    /** The tasks the repo offers, with the problems of reading them. Read from disk every time, so edits apply at once. */
    tasks(repo: string): TaskFile {
        const files: TaskFile[] = [];
        const own = join(repo, '.vscode', 'tasks.json');
        if (existsSync(own)) {
            const file = parseTasksJson(readFileSync(own, 'utf8'), this.platform, 'folder');
            files.push({ ...file, problems: file.problems.map(p => `${own}: ${p}`) });
        }
        for (const workspace of this.options.workspaceFiles?.(repo) ?? []) {
            try {
                const section = readCodeWorkspace(workspace).data.tasks;
                if (section === undefined) continue;
                const file = readTasks(section, this.platform, 'workspace');
                files.push({ ...file, problems: file.problems.map(p => `${workspace}: ${p}`) });
            } catch {
                // a workspace file that does not parse has no tasks
            }
        }
        const cli = this.options.cli?.(repo);
        if (cli) files.push(builtinTasks(cli));
        return combineTasks(...files);
    }

    state(repo: string, label: string): TaskState {
        return this.store.repos[repo]?.tasks[label] ?? IDLE;
    }

    /** Every repo's task states, for the rail. */
    states(): Map<string, Record<string, TaskState>> {
        return new Map(Object.entries(this.store.repos).filter(([repo]) => this.opened.has(repo)).map(([repo, entry]) => [repo, entry.tasks]));
    }

    /** The task list of a repo: its tasks with their states, then tasks still running that are no longer defined. */
    list(repo: string): TaskItem[] {
        const file = this.tasks(repo);
        const items: TaskItem[] = file.tasks.map(task => ({
            label: task.label, source: task.source,
            ...task.detail ? { detail: task.detail } : {},
            ...task.group ? { group: task.group.kind } : {},
            background: task.isBackground, automatic: task.runOn === 'folderOpen', hidden: task.hide,
            inputs: this.inputsFor(file, task.label), state: this.state(repo, task.label)
        }));
        for (const [label, state] of Object.entries(this.store.repos[repo]?.tasks ?? {})) {
            if (!items.some(item => item.label === label) && (isActive(state) || state.terminal)) {
                items.push({ label, source: 'gone', background: state.background, automatic: false, hidden: false, inputs: [], state });
            }
        }
        return items;
    }

    /** The inputs a run of the task asks for: those its plan uses, each once. */
    inputsFor(file: TaskFile, label: string): TaskInput[] {
        let labels: string[];
        try {
            labels = planLabels(dependencyPlan(label, file.tasks));
        } catch {
            return [];
        }
        const ids = [...new Set(labels.flatMap(l => inputsUsed(file.tasks.find(t => t.label === l)!)))];
        return ids.map(id => file.inputs.find(input => input.id === id) ?? { id, type: 'promptString' });
    }

    /** The automatic tasks decision of a repo. */
    automatic(repo: string): AutomaticTasks | undefined {
        return this.store.repos[repo]?.automatic;
    }

    setAutomatic(repo: string, decision: AutomaticTasks | undefined): void {
        const entry = this.entry(repo);
        if (decision) entry.automatic = decision;
        else delete entry.automatic;
        this.save();
    }

    /**
     * A repo opened: its task terminals are found again in the pty host and each task's state follows them (a task
     * that ended meanwhile gets its exit status, a background task its readiness from the scrollback); then the
     * `folderOpen` tasks start, once the user allowed automatic tasks in the folder.
     */
    async openRepo(repo: string): Promise<void> {
        if (this.opened.has(repo)) return;
        this.opened.add(repo);
        await this.service.openRepo(repo);
        const file = this.tasks(repo);
        for (const [label, state] of Object.entries(this.entry(repo).tasks)) {
            if (!state.terminal) {
                // a run that waited for dependencies when the app went
                if (isActive(state)) this.apply(repo, label, { type: 'lost' });
                continue;
            }
            const terminal = this.service.state(state.terminal);
            if (!terminal) {
                this.routes.delete(state.terminal);
                this.apply(repo, label, isActive(state) ? { type: 'lost' } : undefined, { terminal: undefined });
                continue;
            }
            if (!isActive(state)) continue;
            if (terminal.exit) {
                this.apply(repo, label, { type: 'exit', ...terminal.exit });
                continue;
            }
            const route = this.routes.get(state.terminal) ?? { repo, label };
            this.routes.set(state.terminal, route);
            const definition = file.tasks.find(t => t.label === label);
            if (definition?.background) {
                route.matcher = new BackgroundMatcher(definition.background);
                if (route.scrollback !== undefined) this.reattached(state.terminal, route.scrollback);
            }
        }
        this.emit('changed', repo);
        await this.runAutomatic(repo, file);
    }

    private async runAutomatic(repo: string, file: TaskFile): Promise<void> {
        const automatic = file.tasks.filter(task => task.runOn === 'folderOpen');
        if (!automatic.length) return;
        let decision = this.automatic(repo);
        if (!decision) {
            decision = await this.options.askAutomatic?.(repo, automatic.map(t => t.label));
            if (!decision || !this.opened.has(repo)) return;
            this.setAutomatic(repo, decision);
        }
        if (decision !== 'allow') return;
        for (const task of automatic) {
            // a background task kept running from the last start is not started twice
            if (isActive(this.state(repo, task.label))) continue;
            if (this.inputsFor(file, task.label).length) continue;
            void this.run(repo, task.label).catch(error => console.error(`Task "${task.label}" of ${repo} did not start: ${(error as Error).message}`));
        }
    }

    /** The repo left every workspace: its terminals end with it (the terminal panel kills them), the states go. */
    closeRepo(repo: string): void {
        this.opened.delete(repo);
        const entry = this.store.repos[repo];
        if (!entry) return;
        for (const state of Object.values(entry.tasks)) if (state.terminal) this.routes.delete(state.terminal);
        entry.tasks = {};
        this.save();
        this.emit('changed', repo);
    }

    /**
     * Runs a task after its dependencies. Resolves when the task settled: it ended, or a background task got ready.
     * Throws when the task does not exist, its dependencies form a cycle, it runs already or an input is missing.
     */
    async run(repo: string, label: string, options: RunOptions = {}): Promise<TaskState> {
        const file = this.tasks(repo);
        const plan = dependencyPlan(label, file.tasks);
        if (isActive(this.state(repo, label))) throw new Error(`Task "${label}" is running already.`);
        const missing = this.inputsFor(file, label).filter(input => options.inputs?.[input.id] === undefined || (input.allowEmpty === false && !options.inputs[input.id]));
        if (missing.length) throw new Error(`Task "${label}" needs ${missing.map(i => i.description ?? i.id).join(', ')}.`);
        this.opened.add(repo);
        if (plan.deps.length) this.apply(repo, label, { type: 'wait' });
        await executePlan(
            plan,
            step => this.runOne(repo, step, file, options, step === label, step === label && plan.deps.length > 0),
            (step, reason) => this.apply(repo, step, { type: 'fail', reason })
        );
        return this.state(repo, label);
    }

    /**
     * One task of a plan, its dependencies done: waits for it when it runs already, else starts it in a new terminal.
     * `waited` marks the task the user ran when it waited for its dependencies (it may have been stopped meanwhile).
     */
    private async runOne(repo: string, label: string, file: TaskFile, options: RunOptions, root: boolean, waited: boolean): Promise<StepResult> {
        const task = file.tasks.find(t => t.label === label)!;
        const current = this.state(repo, label);
        if (waited && current.status === 'stopped') return { ok: false, reason: `"${label}" was stopped` };
        // a dependency that runs already (a watcher another task started) is waited for, not started twice
        if (!waited && isActive(current)) return this.settledResult(repo, label);
        if (!task.command) {
            if (current.status !== 'waiting') this.apply(repo, label, { type: 'wait' });
            this.apply(repo, label, { type: 'done' });
            return { ok: true };
        }
        const problems: string[] = [];
        const context: VariableContext = {
            workspaceFolder: repo, folders: this.options.folders?.(repo), env: this.options.env ?? process.env,
            userHome: this.options.userHome ?? homedir(), platform: this.platform, inputs: options.inputs
        };
        const launch = taskLaunch(task, context, problems);
        if (problems.length) console.error(`Task "${label}" of ${repo}: no value for ${problems.join(', ')}`);
        // a new run replaces the terminal of the last one
        if (current.terminal) await this.closeTerminal(current.terminal);
        let started: string | undefined;
        try {
            await this.service.create(repo, { name: `Task - ${label}`, command: launch.command, args: launch.args, env: launch.env, cwd: launch.cwd }, id => {
                // routed from the spawn on, so the matcher sees the first line
                started = id;
                this.service.programs.add(id);
                this.routes.set(id, { repo, label, ...task.background ? { matcher: new BackgroundMatcher(task.background) } : {} });
                this.apply(repo, label, { type: 'start', terminal: id, background: task.isBackground, ready: readyAtStart(task.background) });
            });
        } catch (error) {
            if (started) this.routes.delete(started);
            this.apply(repo, label, { type: 'fail', reason: `it did not start: ${(error as Error).message}` });
            return { ok: false, reason: `"${label}" did not start` };
        }
        if (root && options.manual && task.presentation.reveal === 'always' && started) this.options.reveal?.(repo, started);
        const result = await this.settledResult(repo, label);
        const after = this.state(repo, label);
        if (root && options.manual && task.presentation.reveal === 'silent' && after.status === 'failed' && after.terminal) this.options.reveal?.(repo, after.terminal);
        return result;
    }

    /** Resolves once the task settled, with whether its dependents may go on. */
    private settledResult(repo: string, label: string): Promise<StepResult> {
        const result = (): StepResult | undefined => {
            const state = this.state(repo, label);
            if (!settled(state)) return undefined;
            if (state.status === 'succeeded' || state.status === 'running') return { ok: true };
            return { ok: false, reason: `"${label}" ${state.status === 'stopped' ? 'was stopped' : state.reason ?? 'failed'}` };
        };
        const now = result();
        if (now) return Promise.resolve(now);
        return new Promise(done => {
            const check = (changed: string) => {
                if (changed !== repo) return;
                const value = result();
                if (!value) return;
                this.off('changed', check);
                done(value);
            };
            this.on('changed', check);
        });
    }

    /** Stops a running task (SIGTERM, then SIGKILL); its terminal stays with the output. A waiting task does not start. */
    async stop(repo: string, label: string): Promise<void> {
        const state = this.state(repo, label);
        if (!isActive(state)) return;
        this.apply(repo, label, { type: 'stop' });
        const id = state.terminal;
        if (!id || this.service.state(id)?.exit) return;
        await this.service.signal(id, 'SIGTERM').catch(() => undefined);
        const deadline = Date.now() + (this.options.killAfter ?? 3000);
        while (Date.now() < deadline) {
            const terminal = this.service.state(id);
            if (!terminal || terminal.exit) return;
            await new Promise(done => setTimeout(done, 50));
        }
        await this.service.signal(id, 'SIGKILL').catch(() => undefined);
    }

    /** Stops the task when it runs, then runs it again. */
    async restart(repo: string, label: string, options: RunOptions = {}): Promise<TaskState> {
        await this.stop(repo, label);
        return this.run(repo, label, options);
    }

    private async closeTerminal(id: string): Promise<void> {
        this.routes.delete(id);
        await this.service.kill(id);
    }

    private output(id: string, data: string): void {
        const route = this.routes.get(id);
        if (!route?.matcher || this.state(route.repo, route.label).terminal !== id) return;
        for (const event of route.matcher.feed(data)) this.apply(route.repo, route.label, { type: event });
    }

    private exited(id: string, exit: { code: number, signal?: number }): void {
        const route = this.routes.get(id);
        if (!route || this.state(route.repo, route.label).terminal !== id) return;
        this.apply(route.repo, route.label, { type: 'exit', ...exit });
        const task = this.tasks(route.repo).tasks.find(t => t.label === route.label);
        if (task?.presentation.close) void this.closeTerminal(id);
    }

    /** A task terminal attached again: a background task's readiness is read from its screen and scrollback. */
    private reattached(id: string, scrollback: string): void {
        const route = this.routes.get(id);
        if (!route) return;
        if (!route.matcher) {
            route.scrollback = scrollback;
            return;
        }
        route.scrollback = undefined;
        const state = this.state(route.repo, route.label);
        if (state.terminal !== id || state.status !== 'running') return;
        const ready = route.matcher.readyIn(scrollback);
        if (ready !== undefined) this.apply(route.repo, route.label, { type: ready ? 'end' : 'begin' });
    }

    private entry(repo: string): TaskStoreData['repos'][string] {
        return this.store.repos[repo] ??= { tasks: {} };
    }

    /** Moves a task's state by an event (or patches it), saves and tells the listeners. */
    private apply(repo: string, label: string, event: TaskEvent | undefined, patch: Partial<TaskState> = {}): void {
        const entry = this.entry(repo);
        const before = entry.tasks[label] ?? IDLE;
        let next: TaskState = { ...event ? transition(before, event) : before, ...patch };
        if (patch.terminal === undefined && 'terminal' in patch) {
            const { terminal: _, ...rest } = next;
            next = rest;
        }
        if (JSON.stringify(next) === JSON.stringify(before)) return;
        entry.tasks[label] = next;
        this.save();
        this.emit('changed', repo);
    }

    private save(): void {
        const file = this.options.storeFile;
        if (!file) return;
        try {
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, `${JSON.stringify(this.store, null, 2)}\n`);
        } catch {
            // the states are then found again from the terminals' exit at the next start, as far as they can be
        }
    }
}

function safeJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

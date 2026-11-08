import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { dialog, ipcMain, shell, type BaseWindow, type MenuItemConstructorOptions, type WebContents } from 'electron';
import { programPath } from '../resources.js';
import type { TerminalService } from '../terminal/service.js';
import { applingCli } from './builtin.js';
import type { Platform } from './definitions.js';
import { TaskRunner, type TaskItem } from './runner.js';
import { isActive, type TaskState } from './state.js';

export interface TaskHost {
    userData: string;
    service: TerminalService;
    /** The repo the focused window shows. */
    activeRepo(): string | undefined;
    workspaceFiles(repo: string): string[];
    folders(repo: string): Record<string, string>;
    /** The focused window, for dialogs. */
    window(): BaseWindow | undefined;
    /** The focused window's shell page, which draws the task list. */
    shell(): WebContents | undefined;
    /** The task list opens or closes: the main process hides the repo views behind the shell page meanwhile. */
    shown(open: boolean): void;
    /** Shows a terminal in the repo's terminal panel. */
    reveal(repo: string, terminal: string): void;
}

/** What the shell page's task list shows. */
export interface TaskListView {
    repo?: string;
    name?: string;
    tasks: (TaskItem & { line: string })[];
    problems: string[];
}

/**
 * The tasks in the app (Electron glue over `TaskRunner`): the Tasks menu, the task list the shell page draws (run,
 * restart, stop, the inputs a task asks for), and the question whether a folder's automatic tasks may run.
 */
export class TaskController {
    readonly runner: TaskRunner;
    private open = false;

    constructor(private readonly host: TaskHost) {
        const platform = process.platform as Platform;
        this.runner = new TaskRunner(host.service, {
            storeFile: join(host.userData, 'task-states.json'),
            platform,
            workspaceFiles: repo => host.workspaceFiles(repo),
            folders: repo => host.folders(repo),
            cli: repo => {
                try {
                    return applingCli(repo, { platform, exists: existsSync, node: process.execPath, cli: programPath('cli') });
                } catch {
                    return undefined;
                }
            },
            askAutomatic: (repo, labels) => this.askAutomatic(repo, labels),
            reveal: (repo, terminal) => host.reveal(repo, terminal)
        });
        this.runner.on('changed', repo => {
            if (this.open && repo === this.host.activeRepo()) this.push();
        });
        this.handle();
    }

    openRepo(repo: string): void {
        this.runner.openRepo(repo).catch(error => console.error(`The tasks of ${repo} did not reattach: ${(error as Error).message}`));
    }

    closeRepo(repo: string): void {
        this.runner.closeRepo(repo);
    }

    /** VS Code's question before a folder's first automatic tasks; the answer is kept per folder. */
    private async askAutomatic(repo: string, labels: string[]): Promise<'allow' | 'deny' | undefined> {
        const window = this.host.window();
        const options = {
            type: 'question' as const,
            title: 'Automatic Tasks',
            message: `${basename(repo)} has tasks that start when it opens: ${labels.join(', ')}.`,
            detail: 'Do you allow automatic tasks to run in this folder? The answer is kept; the Tasks menu changes it.',
            buttons: ['Allow', 'Disallow', 'Open tasks.json'],
            defaultId: 0, cancelId: 1, noLink: true
        };
        const { response } = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
        if (response === 2) {
            void shell.openPath(join(repo, '.vscode', 'tasks.json'));
            return undefined;
        }
        return response === 0 ? 'allow' : 'deny';
    }

    /** The task list of the active repo. */
    view(): TaskListView {
        const repo = this.host.activeRepo();
        if (!repo) return { tasks: [], problems: [] };
        const file = this.runner.tasks(repo);
        return {
            repo, name: basename(repo), problems: file.problems,
            tasks: this.runner.list(repo).map(item => ({ ...item, line: commandLine(file.tasks.find(t => t.label === item.label)) }))
        };
    }

    /** Opens the task list ("Run Task…") over the focused window. */
    show(): void {
        const shell = this.host.shell();
        if (!shell) return;
        this.open = true;
        this.host.shown(true);
        shell.focus();
        shell.send('tasks:open', this.view());
    }

    private hide(): void {
        if (!this.open) return;
        this.open = false;
        this.host.shown(false);
    }

    private push(): void {
        this.host.shell()?.send('tasks:list', this.view());
    }

    /** Runs a task of the active repo; one asking for inputs opens the task list on it instead. */
    run(label: string, inputs?: Record<string, string>, restart = false): void {
        const repo = this.host.activeRepo();
        if (!repo) return;
        const item = this.runner.list(repo).find(i => i.label === label);
        if (item?.inputs.length && !inputs) {
            this.show();
            this.host.shell()?.send('tasks:ask', label);
            return;
        }
        const running = restart ? this.runner.restart(repo, label, { inputs, manual: true }) : this.runner.run(repo, label, { inputs, manual: true });
        running.catch(error => dialog.showErrorBox(`Task "${label}" did not run`, (error as Error).message));
    }

    /** Runs the default build task (`group: { kind: "build", isDefault: true }`), else asks for a build task. */
    runBuild(): void {
        const repo = this.host.activeRepo();
        if (!repo) return;
        const tasks = this.runner.tasks(repo).tasks.filter(t => t.group?.kind === 'build');
        const preferred = tasks.find(t => t.group?.isDefault) ?? (tasks.length === 1 ? tasks[0] : undefined);
        if (preferred) this.run(preferred.label);
        else this.show();
    }

    /** The Tasks menu: run a task, the default build task, then each task of the active repo with run, restart and stop. */
    menu(item: (command: string) => MenuItemConstructorOptions): MenuItemConstructorOptions[] {
        const repo = this.host.activeRepo();
        const items = repo ? this.runner.list(repo).filter(i => !i.hidden) : [];
        const decision = repo ? this.runner.automatic(repo) : undefined;
        return [
            item('runTask'), item('runBuildTask'),
            ...items.length ? [{ type: 'separator' as const }] : [],
            ...items.map((task): MenuItemConstructorOptions => {
                const active = isActive(task.state);
                return {
                    label: `${task.label}${stateLabel(task.state) ? `  ·  ${stateLabel(task.state)}` : ''}`,
                    submenu: [
                        { label: 'Run', enabled: !active, click: () => this.run(task.label) },
                        { label: 'Restart', enabled: active && !task.inputs.length, click: () => this.run(task.label, undefined, true) },
                        { label: 'Stop', enabled: active, click: () => repo && void this.runner.stop(repo, task.label) },
                        { type: 'separator' },
                        { label: 'Show Terminal', enabled: !!task.state.terminal, click: () => repo && task.state.terminal && this.host.reveal(repo, task.state.terminal) }
                    ]
                };
            }),
            { type: 'separator' },
            {
                label: 'Allow Automatic Tasks in Folder', type: 'checkbox', enabled: !!repo, checked: decision === 'allow',
                click: menuItem => repo && this.runner.setAutomatic(repo, menuItem.checked ? 'allow' : 'deny')
            },
            { label: 'Configure Tasks…', enabled: !!repo, click: () => repo && this.configure(repo) }
        ];
    }

    /** Opens the repo's `.vscode/tasks.json`, writing an empty one first when there is none. */
    private configure(repo: string): void {
        const file = join(repo, '.vscode', 'tasks.json');
        if (!existsSync(file)) {
            mkdirSync(join(repo, '.vscode'), { recursive: true });
            writeFileSync(file, '{\n    // See https://go.microsoft.com/fwlink/?LinkId=733558 for the format\n    "version": "2.0.0",\n    "tasks": []\n}\n');
        }
        void shell.openPath(file);
    }

    private handle(): void {
        const own = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => event.sender === this.host.shell();
        ipcMain.handle('tasks:view', event => own(event) ? this.view() : undefined);
        ipcMain.on('tasks:run', (event, label, inputs, restart) => {
            if (!own(event) || typeof label !== 'string') return;
            const values = inputs && typeof inputs === 'object' ? Object.fromEntries(Object.entries(inputs).filter(([, v]) => typeof v === 'string')) as Record<string, string> : undefined;
            this.run(label, values, restart === true);
        });
        ipcMain.on('tasks:stop', (event, label) => {
            const repo = this.host.activeRepo();
            if (own(event) && repo && typeof label === 'string') void this.runner.stop(repo, label);
        });
        ipcMain.on('tasks:show', (event, label) => {
            const repo = this.host.activeRepo();
            const terminal = repo && typeof label === 'string' ? this.runner.state(repo, label).terminal : undefined;
            if (!own(event) || !repo || !terminal) return;
            this.hide();
            this.host.reveal(repo, terminal);
        });
        ipcMain.on('tasks:close', event => own(event) && this.hide());
    }
}

function stateLabel(state: TaskState): string {
    if (state.status === 'running') return state.background ? state.ready ? 'ready' : 'starting' : 'running';
    if (state.status === 'idle') return '';
    return state.status;
}

function commandLine(task: { label: string, source: string, command?: string, args: (string | { value: string })[], dependsOn: string[] } | undefined): string {
    if (!task) return '';
    if (task.source === 'appling') return task.label.replace(': ', ' ');
    if (!task.command) return `runs ${task.dependsOn.join(', ')}`;
    return [task.command, ...task.args.map(a => typeof a === 'string' ? a : a.value)].join(' ');
}

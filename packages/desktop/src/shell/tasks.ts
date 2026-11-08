/**
 * The task list over the shell page ("Run Task…", issue #13): the active repo's tasks with their state; type to
 * filter, arrows to move, Enter runs the selected task (or shows the terminal of one that runs), the buttons run,
 * restart, stop and show the terminal. A task with inputs (`${input:…}`, the version of `appling release`) asks for
 * them in the same field first. Escape goes back from the inputs, then closes.
 */
import type { TaskListView } from '../tasks/ipc.js';

type Task = TaskListView['tasks'][number];

interface TasksBridge {
    view(): Promise<TaskListView | undefined>;
    onOpen(callback: (view: TaskListView) => void): void;
    onList(callback: (view: TaskListView) => void): void;
    onAsk(callback: (label: string) => void): void;
    run(label: string, inputs?: Record<string, string>, restart?: boolean): void;
    stop(label: string): void;
    show(label: string): void;
    close(): void;
}

const bridge = (window as unknown as { appling: { tasks: TasksBridge } }).appling.tasks;
const dialog = document.querySelector<HTMLElement>('#tasks')!;
const input = dialog.querySelector<HTMLInputElement>('input')!;
const list = dialog.querySelector<HTMLElement>('ul')!;
const problems = dialog.querySelector<HTMLElement>('.problems')!;

let view: TaskListView = { tasks: [], problems: [] };
let selected = 0;
/** While a task's inputs are asked: the task, whether it restarts, the values so far and the input being asked. */
let asking: { task: Task, restart: boolean, values: Record<string, string>, index: number } | undefined;

const isActive = (task: Task) => task.state.status === 'running' || task.state.status === 'waiting';

function status(task: Task): string {
    const { state } = task;
    if (state.status === 'running' && state.background) return state.ready ? 'ready' : 'starting';
    if (state.status === 'failed' && state.reason) return `failed: ${state.reason}`;
    return state.status === 'idle' ? '' : state.status;
}

function visible(): Task[] {
    const query = input.value.trim().toLowerCase();
    return view.tasks.filter(task => !task.hidden && (!query || task.label.toLowerCase().includes(query)));
}

/** The options shown while an input is asked: a pickString's choices, filtered by the field. */
function choices(): string[] {
    if (!asking) return [];
    const current = asking.task.inputs[asking.index];
    const query = input.value.trim().toLowerCase();
    return (current.options ?? []).filter(option => !query || option.toLowerCase().includes(query));
}

function render(): void {
    problems.textContent = view.problems.join('\n');
    if (asking) return renderInput();
    input.placeholder = view.name ? `Run a task of ${view.name}…` : 'No repo is shown';
    const tasks = visible();
    selected = Math.min(selected, Math.max(0, tasks.length - 1));
    list.replaceChildren(...tasks.map((task, index) => {
        const item = document.createElement('li');
        const ready = task.state.status === 'running' && task.state.background && task.state.ready;
        item.className = `${task.state.status}${ready ? ' ready' : ''}${index === selected ? ' selected' : ''}`;
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', String(index === selected));
        const dot = document.createElement('span');
        dot.className = 'dot';
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = task.label;
        const meta = document.createElement('span');
        meta.className = 'meta';
        meta.textContent = [status(task), task.detail ?? task.line, task.source === 'appling' ? 'built in' : task.source === 'workspace' ? 'workspace' : task.source === 'gone' ? 'no longer defined' : '', task.automatic ? 'on folder open' : '']
            .filter(Boolean).join(' · ');
        const buttons = document.createElement('span');
        buttons.className = 'buttons';
        const button = (label: string, action: () => void) => {
            const element = document.createElement('button');
            element.type = 'button';
            element.textContent = label;
            element.onmousedown = event => event.preventDefault();
            element.onclick = event => {
                event.stopPropagation();
                action();
            };
            buttons.append(element);
        };
        if (isActive(task)) {
            button('Restart', () => start(task, true));
            button('Stop', () => bridge.stop(task.label));
        } else if (task.source !== 'gone') button('Run', () => start(task, false));
        if (task.state.terminal) button('Terminal', () => close(() => bridge.show(task.label)));
        item.append(dot, name, buttons, meta);
        item.onmousedown = event => event.preventDefault();
        item.onclick = () => pick(task);
        return item;
    }));
    if (!tasks.length) {
        const empty = document.createElement('li');
        empty.className = 'empty';
        empty.textContent = view.tasks.length ? 'No task matches' : 'This repo has no tasks';
        list.append(empty);
    }
    list.children[selected]?.scrollIntoView({ block: 'nearest' });
}

function renderInput(): void {
    const current = asking!.task.inputs[asking!.index];
    input.placeholder = `${asking!.task.label}: ${current.description ?? current.id}${current.default ? ` (${current.default})` : ''}`;
    const options = choices();
    selected = Math.min(selected, Math.max(0, options.length - 1));
    list.replaceChildren(...options.map((option, index) => {
        const item = document.createElement('li');
        item.className = index === selected ? 'selected' : '';
        item.textContent = option;
        item.onmousedown = event => event.preventDefault();
        item.onclick = () => answer(option);
        return item;
    }));
}

/** Enter on a task: run it, or show the terminal of one that runs. */
function pick(task: Task | undefined): void {
    if (!task) return;
    if (isActive(task) || task.source === 'gone') {
        if (task.state.terminal) close(() => bridge.show(task.label));
        return;
    }
    start(task, false);
}

function start(task: Task, restart: boolean): void {
    if (task.inputs.length) {
        asking = { task, restart, values: {}, index: 0 };
        input.value = '';
        selected = 0;
        render();
        return;
    }
    close(() => bridge.run(task.label, undefined, restart));
}

function answer(value: string): void {
    if (!asking) return;
    const current = asking.task.inputs[asking.index];
    const chosen = value || current.default || '';
    if (!chosen && current.allowEmpty === false) return;
    asking.values[current.id] = chosen;
    asking.index++;
    input.value = '';
    selected = 0;
    if (asking.index < asking.task.inputs.length) return render();
    const { task, values, restart } = asking;
    close(() => bridge.run(task.label, values, restart));
}

function close(then?: () => void): void {
    asking = undefined;
    if (!dialog.hidden) {
        dialog.hidden = true;
        bridge.close();
    }
    then?.();
}

function open(next: TaskListView): void {
    view = next;
    asking = undefined;
    dialog.hidden = false;
    input.value = '';
    selected = 0;
    render();
    input.focus();
}

input.oninput = () => {
    selected = 0;
    render();
};
input.onkeydown = event => {
    const count = asking ? choices().length : visible().length;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (!count) return;
        selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + count) % count;
        render();
    } else if (event.key === 'Enter') {
        event.preventDefault();
        if (asking) {
            const options = choices();
            answer(asking.task.inputs[asking.index].type === 'pickString' && options.length ? options[selected] : input.value);
        } else pick(visible()[selected]);
    } else if (event.key === 'Escape') {
        event.preventDefault();
        if (asking) {
            asking = undefined;
            input.value = '';
            render();
        } else close();
    }
};
dialog.onclick = event => event.target === dialog && close();
bridge.onOpen(open);
bridge.onList(next => {
    view = next;
    if (!dialog.hidden) render();
});
// a task picked in the menu that asks for inputs
bridge.onAsk(label => {
    const task = view.tasks.find(t => t.label === label);
    if (task) start(task, false);
});

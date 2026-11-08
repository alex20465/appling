/**
 * The shell page: the rail on the left (workspaces, then the repos of the active one), behind the active repo's view
 * the empty and error states, and the switcher (shown while the main process hides the repo views).
 */

interface RepoState {
    id: string;
    name: string;
    status: 'starting' | 'ready' | 'failed';
    error?: string;
    /** Validation errors of its model. */
    errors: number;
    /** The checked out branch; undefined outside git. */
    branch?: string;
    upstream?: string;
    ahead: number;
    behind: number;
    /** Files with uncommitted changes. */
    dirty: number;
    pinned: boolean;
    hidden: boolean;
}

interface WorkspaceState {
    id: string;
    name: string;
    /** How many repos are hidden from the rail. */
    hidden: number;
    /** Validation errors summed over its repos. */
    errors: number;
    repos: RepoState[];
}

interface ShellState {
    workspaces: WorkspaceState[];
    active?: string;
    repo?: string;
    collapsed: boolean;
}

interface SwitcherEntry {
    repo: string;
    workspace: string;
    name: string;
    workspaceName: string;
    positions: number[];
    active: boolean;
    hidden: boolean;
}

interface Bridge {
    state(): Promise<ShellState>;
    onState(callback: (state: ShellState) => void): void;
    select(repo: string, workspace?: string): void;
    selectWorkspace(id: string): void;
    close(repo: string): void;
    retry(repo: string): void;
    open(): void;
    newWorkspace(): void;
    repoMenu(repo: string): void;
    workspaceMenu(id: string): void;
    pin(workspace: string, repo: string, pinned: boolean): void;
    reorder(workspace: string, repo: string, before?: string): void;
    toggleRail(): void;
    onSwitcher(callback: () => void): void;
    switch(query: string): Promise<SwitcherEntry[]>;
    closeSwitcher(): void;
}

const bridge = (window as unknown as { appling: Bridge }).appling;
const workspaceRail = document.querySelector<HTMLElement>('#workspaces')!;
const repoRail = document.querySelector<HTMLElement>('#repos')!;
const stage = document.querySelector<HTMLElement>('#stage')!;
const switcher = document.querySelector<HTMLElement>('#switcher')!;
const switcherInput = switcher.querySelector<HTMLInputElement>('input')!;
const switcherList = switcher.querySelector<HTMLElement>('ul')!;
/** The repo being dragged in the rail. */
let dragged: string | undefined;

/** Two letters for the rail: the initials of the name's words, or its first two letters. */
function initials(name: string): string {
    const words = name.split(/[-_.\s]+/).filter(Boolean);
    return (words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2)).toUpperCase();
}

function render(state: ShellState): void {
    document.body.classList.toggle('collapsed', state.collapsed);
    workspaceRail.replaceChildren(...state.workspaces.map(workspace => {
        const button = railButton(`workspace${workspace.id === state.active ? ' active' : ''}`, workspace.name, `${workspace.name}\n${workspace.id}\nRight click for more`);
        button.dataset.id = workspace.id;
        button.onclick = () => bridge.selectWorkspace(workspace.id);
        button.oncontextmenu = event => {
            event.preventDefault();
            bridge.workspaceMenu(workspace.id);
        };
        return button;
    }));

    const workspace = state.workspaces.find(w => w.id === state.active);
    for (const button of workspaceRail.querySelectorAll<HTMLElement>('.workspace')) {
        const { hidden = 0, errors = 0 } = state.workspaces.find(w => w.id === button.dataset.id) ?? {};
        if (hidden) button.title += `\n${hidden} hidden repo${hidden > 1 ? 's' : ''}`;
        badge(button, errors);
    }
    repoRail.replaceChildren(...(workspace?.repos ?? []).map(repo => {
        const flags = `${repo.pinned ? ' pinned' : ''}${repo.hidden ? ' hidden' : ''}${repo.id === state.repo ? ' active' : ''}`;
        const note = repo.pinned ? 'Pinned. ' : repo.hidden ? 'Hidden from the rail. ' : '';
        const button = railButton(`repo ${repo.status}${flags}`, repo.name, `${repo.name}\n${repo.id}\n${gitLine(repo)}${note}Drag to reorder, middle click closes, right click for more`);
        badge(button, repo.errors);
        gitMarks(button, repo);
        button.onclick = () => bridge.select(repo.id, workspace!.id);
        button.draggable = true;
        button.ondragstart = event => {
            dragged = repo.id;
            event.dataTransfer?.setData('text/plain', repo.name);
        };
        button.ondragend = () => dragged = undefined;
        button.ondragover = event => dragged && dragged !== repo.id && event.preventDefault();
        button.ondrop = event => {
            event.preventDefault();
            if (dragged && dragged !== repo.id) bridge.reorder(workspace!.id, dragged, repo.id);
            dragged = undefined;
        };
        button.onauxclick = event => event.button === 1 && bridge.close(repo.id);
        button.oncontextmenu = event => {
            event.preventDefault();
            bridge.repoMenu(repo.id);
        };
        return button;
    }));

    const active = workspace?.repos.find(r => r.id === state.repo);
    stage.replaceChildren();
    if (!workspace) {
        stage.append(heading('No workspace open'), paragraph('A workspace groups git repos and is stored as a .code-workspace file, which VS Code opens too.'),
            action('New Workspace…', () => bridge.newWorkspace()), action('Add Folder…', () => bridge.open()));
    } else if (!active) {
        stage.append(heading(workspace.name), paragraph('This workspace has no repos yet. Add a folder, or run appling-desktop <folder> in a terminal.'), action('Add Folder…', () => bridge.open()));
    } else if (active.status === 'starting') {
        stage.append(heading(active.name), paragraph('Starting the IDE server…'));
    } else if (active.status === 'failed') {
        const details = document.createElement('pre');
        details.textContent = active.error ?? '';
        stage.append(heading(`${active.name} did not start`), details, action('Retry', () => bridge.retry(active.id)), action('Close', () => bridge.close(active.id)));
    }
}

function railButton(className: string, name: string, title: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = className;
    button.textContent = initials(name);
    button.title = title;
    button.setAttribute('aria-label', name);
    return button;
}

/** The tooltip line of a repo's git state, such as "On main, 2 ahead and 1 behind origin/main, 3 changed files". */
function gitLine(repo: RepoState): string {
    if (!repo.branch) return '';
    const sync = repo.ahead || repo.behind ? `, ${[repo.ahead && `${repo.ahead} ahead`, repo.behind && `${repo.behind} behind`].filter(Boolean).join(' and ')} ${repo.upstream ?? 'its upstream'}` : '';
    const dirty = repo.dirty ? `, ${repo.dirty} changed file${repo.dirty > 1 ? 's' : ''}` : '';
    return `On ${repo.branch}${sync}${dirty}\n`;
}

/** A dot in the top left corner while the repo has uncommitted changes, and the ahead and behind counts below it. */
function gitMarks(button: HTMLElement, repo: RepoState): void {
    if (repo.dirty) {
        button.classList.add('dirty');
        const dot = document.createElement('span');
        dot.className = 'dirty-dot';
        button.append(dot);
    }
    if (repo.ahead || repo.behind) {
        const sync = document.createElement('span');
        sync.className = 'sync';
        sync.textContent = `${repo.ahead ? `↑${repo.ahead > 9 ? '9+' : repo.ahead}` : ''}${repo.behind ? `↓${repo.behind > 9 ? '9+' : repo.behind}` : ''}`;
        button.append(sync);
    }
}

/** The count of validation errors in the button's corner, and in its tooltip. */
function badge(button: HTMLElement, errors: number): void {
    if (!errors) return;
    const count = document.createElement('span');
    count.className = 'badge';
    count.textContent = errors > 99 ? '99+' : String(errors);
    button.append(count);
    button.title += `\n${errors} validation error${errors > 1 ? 's' : ''}`;
}

function heading(text: string): HTMLElement {
    const element = document.createElement('h1');
    element.textContent = text;
    return element;
}

function paragraph(text: string): HTMLElement {
    const element = document.createElement('p');
    element.textContent = text;
    return element;
}

function action(label: string, click: () => void): HTMLElement {
    const button = document.createElement('button');
    button.className = 'action';
    button.textContent = label;
    button.onclick = click;
    return button;
}

/** The fuzzy switcher over the repos of every workspace: type to filter, arrows to move, Enter to go, Escape to leave. */
let entries: SwitcherEntry[] = [];
let selected = 0;
let asked = 0;

function openSwitcher(): void {
    switcher.hidden = false;
    switcherInput.value = '';
    query();
    switcherInput.focus();
}

function closeSwitcher(): void {
    if (switcher.hidden) return;
    switcher.hidden = true;
    bridge.closeSwitcher();
}

async function query(): Promise<void> {
    const ask = ++asked;
    const result = await bridge.switch(switcherInput.value);
    if (ask !== asked) return;
    entries = result;
    selected = 0;
    renderSwitcher();
}

function pick(entry: SwitcherEntry | undefined): void {
    if (!entry) return;
    switcher.hidden = true;
    bridge.select(entry.repo, entry.workspace);
}

function renderSwitcher(): void {
    switcherList.replaceChildren(...entries.map((entry, index) => {
        const item = document.createElement('li');
        item.className = `${index === selected ? 'selected' : ''}${entry.active ? ' current' : ''}`;
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', String(index === selected));
        const name = document.createElement('span');
        name.className = 'name';
        [...entry.name].forEach((char, at) => {
            if (!entry.positions.includes(at)) return name.append(char);
            const mark = document.createElement('mark');
            mark.textContent = char;
            name.append(mark);
        });
        const where = document.createElement('span');
        where.className = 'where';
        where.textContent = `${entry.workspaceName}${entry.hidden ? ' · hidden' : ''}${entry.active ? ' · shown' : ''}`;
        item.append(name, where);
        item.onmousedown = event => event.preventDefault();
        item.onclick = () => pick(entry);
        return item;
    }));
    if (!entries.length) {
        const empty = document.createElement('li');
        empty.className = 'empty';
        empty.textContent = 'No repo matches';
        switcherList.append(empty);
    }
    switcherList.children[selected]?.scrollIntoView({ block: 'nearest' });
}

switcherInput.oninput = () => query();
switcherInput.onkeydown = event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (!entries.length) return;
        selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length;
        renderSwitcher();
    } else if (event.key === 'Enter') {
        event.preventDefault();
        pick(entries[selected]);
    } else if (event.key === 'Escape') {
        event.preventDefault();
        closeSwitcher();
    }
};
switcher.onclick = event => event.target === switcher && closeSwitcher();
bridge.onSwitcher(openSwitcher);

const open = document.querySelector<HTMLButtonElement>('#open')!;
open.onclick = () => bridge.open();
// a repo dropped on the add button goes to the end of the rail
open.ondragover = event => dragged && event.preventDefault();
open.ondrop = event => {
    event.preventDefault();
    const workspace = document.querySelector<HTMLElement>('#workspaces .workspace.active')?.dataset.id;
    if (dragged && workspace) bridge.reorder(workspace, dragged);
    dragged = undefined;
};
document.querySelector<HTMLButtonElement>('#new-workspace')!.onclick = () => bridge.newWorkspace();
bridge.onState(render);
bridge.state().then(render);

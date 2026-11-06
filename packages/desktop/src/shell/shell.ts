/**
 * The shell page: the rail on the left (workspaces, then the repos of the active one), behind the active repo's view
 * the empty and error states, and the switcher (shown while the main process hides the repo views).
 */

interface RepoState {
    id: string;
    name: string;
    status: 'starting' | 'ready' | 'failed';
    error?: string;
    pinned: boolean;
    hidden: boolean;
}

interface WorkspaceState {
    id: string;
    name: string;
    /** How many repos are hidden from the rail. */
    hidden: number;
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
        const hidden = state.workspaces.find(w => w.id === button.dataset.id)?.hidden ?? 0;
        if (hidden) button.title += `\n${hidden} hidden repo${hidden > 1 ? 's' : ''}`;
    }
    repoRail.replaceChildren(...(workspace?.repos ?? []).map(repo => {
        const flags = `${repo.pinned ? ' pinned' : ''}${repo.hidden ? ' hidden' : ''}${repo.id === state.repo ? ' active' : ''}`;
        const note = repo.pinned ? 'Pinned. ' : repo.hidden ? 'Hidden from the rail. ' : '';
        const button = railButton(`repo ${repo.status}${flags}`, repo.name, `${repo.name}\n${repo.id}\n${note}Drag to reorder, middle click closes, right click for more`);
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

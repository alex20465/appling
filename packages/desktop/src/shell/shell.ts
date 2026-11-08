/**
 * The shell page: the rail on the left (workspaces, then the repos of the active one), behind the active repo's view
 * the empty and error states, and the switcher and the clone form (shown while the main process hides the repo views).
 */
import type { CloneProgress } from '../clone.js';
import type { RailCount, RailCounts } from '../rail-status.js';

/** The rail status of a repo or a workspace (see `rail-status.ts`). */
interface RailView {
    counts: RailCounts;
    branch?: string;
    /** The most urgent count above zero. */
    badge?: { kind: RailCount, count: number };
    /** The repo's git state beyond the branch. */
    git?: { upstream?: string, ahead: number, behind: number, dirty: number };
    /** The tooltip lines: branch and git state, counts, notes. */
    lines: string[];
}

interface RepoState extends RailView {
    id: string;
    name: string;
    status: 'starting' | 'ready' | 'failed';
    error?: string;
    pinned: boolean;
    hidden: boolean;
    /** Set while the repo's canvas was moved into another window. */
    away?: { window: string, pane: string };
}

/** A pane moved into this window (issue #14), shown as a column of its own. */
interface PaneState extends RailView {
    id: string;
    repo: string;
    name: string;
    label: string;
    status: 'starting' | 'ready' | 'failed';
}

interface WorkspaceState extends RailView {
    id: string;
    name: string;
    /** How many repos are hidden from the rail. */
    hidden: number;
    repos: RepoState[];
}

interface ShellState {
    window: { id: string, name: string, main: boolean, count: number };
    /** How many open workspaces other windows hold. */
    elsewhere: number;
    panes: PaneState[];
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
    addMenu(): void;
    openClone(): void;
    move(repo: string, from: string, to: string): void;
    onClone(callback: (form: { parent: string }) => void): void;
    onCloneProgress(callback: (progress: CloneProgress) => void): void;
    chooseCloneParent(current: string): Promise<string | undefined>;
    clone(url: string, parent: string, name?: string): Promise<{ folder?: string, error?: string }>;
    closeClone(): void;
    detach(kind: DragKind, id: string, x: number, y: number): void;
    drop(kind: DragKind, id: string): void;
    paneMenu(pane: string): void;
    focusPane(pane: string): void;
    dockPane(pane: string): void;
}

type DragKind = 'workspace' | 'repo' | 'pane';
/** The drag data of a rail item, so another window's rail can take it. */
const DRAG = 'application/x-appling-item';

const bridge = (window as unknown as { appling: Bridge }).appling;
const workspaceRail = document.querySelector<HTMLElement>('#workspaces')!;
const repoRail = document.querySelector<HTMLElement>('#repos')!;
const paneRail = document.querySelector<HTMLElement>('#panes')!;
const stage = document.querySelector<HTMLElement>('#stage')!;
const switcher = document.querySelector<HTMLElement>('#switcher')!;
const switcherInput = switcher.querySelector<HTMLInputElement>('input')!;
const switcherList = switcher.querySelector<HTMLElement>('ul')!;
/** The repo being dragged in the rail. */
let dragged: string | undefined;
/** Whether a rail item of this window is being dragged (drops from other windows only move items between windows). */
let dragging = false;

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
        // a repo dropped on another workspace moves there
        button.ondragover = event => dragged && workspace.id !== state.active && event.preventDefault();
        button.ondrop = event => {
            event.preventDefault();
            if (dragged && state.active && workspace.id !== state.active) bridge.move(dragged, state.active, workspace.id);
            dragged = undefined;
        };
        detachable(button, 'workspace', workspace.id);
        button.oncontextmenu = event => {
            event.preventDefault();
            bridge.workspaceMenu(workspace.id);
        };
        return button;
    }));

    const workspace = state.workspaces.find(w => w.id === state.active);
    for (const button of workspaceRail.querySelectorAll<HTMLElement>('.workspace')) {
        const shown = state.workspaces.find(w => w.id === button.dataset.id);
        if (!shown) continue;
        if (shown.hidden) button.title += `\n${shown.hidden} hidden repo${shown.hidden > 1 ? 's' : ''}`;
        badge(button, shown);
        unseenMark(button, shown.counts.unseen, shown.id === state.active);
    }
    repoRail.replaceChildren(...(workspace?.repos ?? []).map(repo => {
        const flags = `${repo.pinned ? ' pinned' : ''}${repo.hidden ? ' hidden' : ''}${repo.id === state.repo ? ' active' : ''}`;
        const note = repo.pinned ? 'Pinned. ' : repo.hidden ? 'Hidden from the rail. ' : '';
        const away = repo.away ? `Its canvas is in ${repo.away.window}.\n` : '';
        const button = railButton(`repo ${repo.status}${flags}${repo.away ? ' away' : ''}`, repo.name, `${repo.name}\n${repo.id}\n${away}${note}Drag to reorder, onto a workspace or out of the window, middle click closes, right click for more`);
        badge(button, repo);
        gitMarks(button, repo);
        unseenMark(button, repo.counts.unseen, repo.id === state.repo);
        button.onclick = () => bridge.select(repo.id, workspace!.id);
        button.draggable = true;
        detachable(button, 'repo', repo.id, () => dragged = repo.id);
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

    paneRail.replaceChildren(...(state.panes.length ? [document.createElement('hr')] : []), ...state.panes.map(pane => {
        const button = railButton(`repo pane ${pane.status}`, pane.name, `${pane.name} · ${pane.label}\n${pane.repo}\nMoved into this window. Drag out or right click to move it on or dock it back`);
        badge(button, pane);
        button.onclick = () => bridge.focusPane(pane.id);
        button.oncontextmenu = event => {
            event.preventDefault();
            bridge.paneMenu(pane.id);
        };
        detachable(button, 'pane', pane.id);
        return button;
    }));

    const active = workspace?.repos.find(r => r.id === state.repo);
    stage.replaceChildren();
    if (!workspace && state.panes.length) {
        // the moved panes cover the stage
    } else if (!workspace && state.elsewhere) {
        stage.append(heading(state.window.name), paragraph(`The open workspaces are in other windows. Drag one onto this rail, or open a workspace here.`),
            action('New Workspace…', () => bridge.newWorkspace()));
    } else if (!workspace) {
        stage.append(heading('No workspace open'), paragraph('A workspace groups git repos and is stored as a .code-workspace file, which VS Code opens too.'),
            action('New Workspace…', () => bridge.newWorkspace()), action('Add Folder…', () => bridge.open()), action('Clone Repository…', () => bridge.openClone()));
    } else if (!active) {
        stage.append(heading(workspace.name), paragraph('This workspace has no repos yet. Add a folder, clone one, or run appling-desktop <folder> in a terminal.'),
            action('Add Folder…', () => bridge.open()), action('Clone Repository…', () => bridge.openClone()));
    } else if (active.away) {
        const away = active.away;
        stage.append(heading(active.name), paragraph(`Its canvas is in ${away.window}.`),
            action('Go There', () => bridge.focusPane(away.pane)), action('Dock Here', () => bridge.dockPane(away.pane)));
    } else if (active.status === 'starting') {
        stage.append(heading(active.name), paragraph('Starting the IDE server…'));
    } else if (active.status === 'failed') {
        const details = document.createElement('pre');
        details.textContent = active.error ?? '';
        stage.append(heading(`${active.name} did not start`), details, action('Retry', () => bridge.retry(active.id)), action('Close', () => bridge.close(active.id)));
    }
}

/**
 * Makes a rail item draggable to another window's rail, or out of every window into a new one: a drag that ends
 * without a drop target sends its screen point, and the main process decides (see `dropTarget`).
 */
function detachable(button: HTMLElement, kind: DragKind, id: string, start?: () => void): void {
    button.draggable = true;
    button.ondragstart = event => {
        dragging = true;
        start?.();
        event.dataTransfer?.setData(DRAG, JSON.stringify({ kind, id }));
        event.dataTransfer?.setData('text/plain', button.getAttribute('aria-label') ?? id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    };
    button.ondragend = event => {
        dragged = undefined;
        dragging = false;
        if (event.dataTransfer?.dropEffect === 'none') bridge.detach(kind, id, event.screenX, event.screenY);
    };
}

// a rail item dragged in from another window lands in this window
const rail = document.querySelector<HTMLElement>('.rail')!;
rail.addEventListener('dragover', event => {
    if (!dragging && event.dataTransfer?.types.includes(DRAG)) event.preventDefault();
});
rail.addEventListener('drop', event => {
    const data = event.dataTransfer?.getData(DRAG);
    if (dragging || event.defaultPrevented || !data) return;
    event.preventDefault();
    try {
        const { kind, id } = JSON.parse(data) as { kind: DragKind, id: string };
        bridge.drop(kind, id);
    } catch {
        // not ours
    }
});

function railButton(className: string, name: string, title: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = className;
    button.textContent = initials(name);
    button.title = title;
    button.setAttribute('aria-label', name);
    return button;
}

/** A dot in the top left corner while the repo has uncommitted changes, and the ahead and behind counts below it. */
function gitMarks(button: HTMLElement, repo: RepoState): void {
    const git = repo.git;
    if (!git) return;
    if (git.dirty) {
        button.classList.add('dirty');
        const dot = document.createElement('span');
        dot.className = 'dirty-dot';
        button.append(dot);
    }
    if (git.ahead || git.behind) {
        const sync = document.createElement('span');
        sync.className = 'sync';
        sync.textContent = `${git.ahead ? `↑${git.ahead > 9 ? '9+' : git.ahead}` : ''}${git.behind ? `↓${git.behind > 9 ? '9+' : git.behind}` : ''}`;
        button.append(sync);
    }
}

/** A background repo or workspace with unseen model changes gets a dot in the top right corner (#11). */
function unseenMark(button: HTMLElement, unseen: number, shown: boolean): void {
    if (!unseen || shown) return;
    button.classList.add('unseen');
    const dot = document.createElement('span');
    dot.className = 'unseen-dot';
    button.append(dot);
}

/**
 * The status in the button's corner: the most urgent count, coloured by its kind (agent waiting, failure, errors,
 * work in progress, unsaved files); an agent at work also rings the button. Every line goes into the tooltip.
 */
function badge(button: HTMLElement, status: RailView): void {
    if (status.lines.length) button.title += `\n${status.lines.join('\n')}`;
    button.classList.toggle('working', status.counts.agentsWorking > 0 || status.counts.tasksRunning > 0);
    if (!status.badge) return;
    const count = document.createElement('span');
    count.className = `badge ${status.badge.kind}`;
    count.textContent = status.badge.count > 99 ? '99+' : String(status.badge.count);
    button.append(count);
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
open.onclick = () => bridge.addMenu();
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

/** The clone form: a git URL and the folder to clone into; progress and git's error show below. */
const cloneForm = document.querySelector<HTMLFormElement>('#clone')!;
const cloneUrl = cloneForm.querySelector<HTMLInputElement>('[name=url]')!;
const cloneParent = cloneForm.querySelector<HTMLInputElement>('[name=parent]')!;
const cloneStatus = cloneForm.querySelector<HTMLElement>('.status')!;
const cloneSubmit = cloneForm.querySelector<HTMLButtonElement>('[type=submit]')!;
let cloning = false;

function closeClone(): void {
    if (cloneForm.hidden) return;
    cloneForm.hidden = true;
    cloning = false;
    bridge.closeClone();
}

function cloneMessage(text: string, error = false): void {
    cloneStatus.textContent = text;
    cloneStatus.classList.toggle('error', error);
}

bridge.onClone(({ parent }) => {
    cloneForm.hidden = false;
    cloneUrl.value = '';
    cloneParent.value = parent;
    cloneMessage('');
    cloneSubmit.disabled = false;
    cloneUrl.focus();
});
bridge.onCloneProgress(progress => cloning && cloneMessage(progress.percent === undefined ? `${progress.phase}…` : `${progress.phase}: ${progress.percent}%`));
cloneForm.querySelector<HTMLButtonElement>('.choose')!.onclick = async () => {
    const chosen = await bridge.chooseCloneParent(cloneParent.value);
    if (chosen) cloneParent.value = chosen;
};
cloneForm.querySelector<HTMLButtonElement>('.cancel')!.onclick = () => closeClone();
cloneForm.onsubmit = async event => {
    event.preventDefault();
    if (cloning) return;
    cloning = true;
    cloneSubmit.disabled = true;
    cloneMessage('Cloning…');
    const result = await bridge.clone(cloneUrl.value, cloneParent.value);
    if (!cloning) return;
    cloning = false;
    cloneSubmit.disabled = false;
    if (result.error) cloneMessage(result.error, true);
    else cloneForm.hidden = true;
};
cloneForm.onkeydown = event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    closeClone();
};

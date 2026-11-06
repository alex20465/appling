/** The shell page: the rail on the left (workspaces, then the repos of the active one) and, behind the active repo's view, the empty and error states. */

interface RepoState {
    id: string;
    name: string;
    status: 'starting' | 'ready' | 'failed';
    error?: string;
}

interface WorkspaceState {
    id: string;
    name: string;
    repos: RepoState[];
}

interface ShellState {
    workspaces: WorkspaceState[];
    active?: string;
    repo?: string;
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
}

const bridge = (window as unknown as { appling: Bridge }).appling;
const workspaceRail = document.querySelector<HTMLElement>('#workspaces')!;
const repoRail = document.querySelector<HTMLElement>('#repos')!;
const stage = document.querySelector<HTMLElement>('#stage')!;

/** Two letters for the rail: the initials of the name's words, or its first two letters. */
function initials(name: string): string {
    const words = name.split(/[-_.\s]+/).filter(Boolean);
    return (words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2)).toUpperCase();
}

function render(state: ShellState): void {
    workspaceRail.replaceChildren(...state.workspaces.map(workspace => {
        const button = railButton(`workspace${workspace.id === state.active ? ' active' : ''}`, workspace.name, `${workspace.name}\n${workspace.id}\nRight click for more`);
        button.onclick = () => bridge.selectWorkspace(workspace.id);
        button.oncontextmenu = event => {
            event.preventDefault();
            bridge.workspaceMenu(workspace.id);
        };
        return button;
    }));

    const workspace = state.workspaces.find(w => w.id === state.active);
    repoRail.replaceChildren(...(workspace?.repos ?? []).map(repo => {
        const button = railButton(`repo ${repo.status}${repo.id === state.repo ? ' active' : ''}`, repo.name, `${repo.name}\n${repo.id}\nMiddle click closes, right click for more`);
        button.onclick = () => bridge.select(repo.id, workspace!.id);
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

document.querySelector<HTMLButtonElement>('#open')!.onclick = () => bridge.open();
document.querySelector<HTMLButtonElement>('#new-workspace')!.onclick = () => bridge.newWorkspace();
bridge.onState(render);
bridge.state().then(render);

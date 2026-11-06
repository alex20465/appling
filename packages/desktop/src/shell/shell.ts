/** The shell page: the repo rail on the left and, behind the active repo's view, the empty and error states. */

interface RepoState {
    id: string;
    name: string;
    status: 'starting' | 'ready' | 'failed';
    error?: string;
}

interface ShellState {
    repos: RepoState[];
    active?: string;
}

interface Bridge {
    state(): Promise<ShellState>;
    onState(callback: (state: ShellState) => void): void;
    select(id: string): void;
    close(id: string): void;
    retry(id: string): void;
    open(): void;
}

const bridge = (window as unknown as { appling: Bridge }).appling;
const rail = document.querySelector<HTMLElement>('#repos')!;
const stage = document.querySelector<HTMLElement>('#stage')!;

/** Two letters for the rail: the initials of the folder name's words, or its first two letters. */
function initials(name: string): string {
    const words = name.split(/[-_.\s]+/).filter(Boolean);
    return (words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2)).toUpperCase();
}

function render(state: ShellState): void {
    rail.replaceChildren(...state.repos.map(repo => {
        const button = document.createElement('button');
        button.className = `repo ${repo.status}${repo.id === state.active ? ' active' : ''}`;
        button.textContent = initials(repo.name);
        button.title = `${repo.name}\n${repo.id}\nMiddle click closes`;
        button.setAttribute('aria-label', repo.name);
        button.onclick = () => bridge.select(repo.id);
        button.onauxclick = event => event.button === 1 && bridge.close(repo.id);
        return button;
    }));

    const active = state.repos.find(r => r.id === state.active);
    stage.replaceChildren();
    if (!active) {
        stage.append(heading('No repo open'), paragraph('Open a folder with File › Open Folder, or run appling-desktop <folder> in a terminal.'), action('Open Folder…', () => bridge.open()));
    } else if (active.status === 'starting') {
        stage.append(heading(active.name), paragraph('Starting the IDE server…'));
    } else if (active.status === 'failed') {
        const details = document.createElement('pre');
        details.textContent = active.error ?? '';
        stage.append(heading(`${active.name} did not start`), details, action('Retry', () => bridge.retry(active.id)), action('Close', () => bridge.close(active.id)));
    }
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
bridge.onState(render);
bridge.state().then(render);

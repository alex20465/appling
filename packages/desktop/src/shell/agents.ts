/**
 * The agent sessions on the shell page (#10): a dot per session under its repo's rail button (status colour, the
 * shown one ringed), the session board over every workspace and repo, and the answer form for a session that needs
 * input (allow, deny, an option, a typed reply), which writes to the agent's terminal without opening it.
 */

/** A session under its repo's rail button (`railSessions` in `agents/board.ts`). */
export interface RailSession {
    id: string;
    title: string;
    status: string;
    statusColor: string;
    color: string;
    active: boolean;
    prompt?: { kind: 'permission' | 'question' | 'input', message: string };
}

/** A line of the board (`BoardEntry` in `agents/board.ts`). */
interface BoardEntry extends RailSession {
    name: string;
    statusLabel: string;
    repo: string;
    repoName: string;
    workspaceName?: string;
    duration: string;
    note?: string;
}

type Answer = { kind: 'allow' } | { kind: 'deny' } | { kind: 'option', option: number } | { kind: 'reply', text: string };

interface AgentBridge {
    agentJump(id: string): void;
    agentBoard(): void;
    agentOpenAnswer(id: string): void;
    agentClose(): void;
    agentAnswer(id: string, answer: Answer): void;
    agentRename(id: string, label: string): void;
    agentEnd(id: string): void;
    onAgentBoard(callback: (entries: BoardEntry[]) => void): void;
    onAgentAnswer(callback: (entry: BoardEntry) => void): void;
    onAgentClose(callback: () => void): void;
}

const bridge = (window as unknown as { appling: AgentBridge }).appling;
const WAITING = new Set(['needs-input', 'blocked']);
const SHOWN = 5;

/** The dots under a repo's rail button: a click on a waiting one opens its answer form, on any other its tab. */
export function agentDots(sessions: RailSession[]): HTMLElement[] {
    if (!sessions.length) return [];
    const row = document.createElement('div');
    row.className = 'agent-dots';
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', 'Agent sessions');
    for (const session of sessions.slice(0, SHOWN)) {
        const dot = document.createElement('button');
        dot.className = `agent-dot${session.active ? ' active' : ''}${WAITING.has(session.status) ? ' waiting' : ''}`;
        dot.style.setProperty('--status', session.statusColor);
        dot.style.setProperty('--session', session.color);
        dot.title = `${session.title}: ${session.status}${session.prompt ? `\n${session.prompt.message}\nClick to answer` : '\nClick to show its tab'}`;
        dot.setAttribute('aria-label', `${session.title}, ${session.status}`);
        dot.onclick = () => session.prompt && WAITING.has(session.status) ? bridge.agentOpenAnswer(session.id) : bridge.agentJump(session.id);
        row.append(dot);
    }
    if (sessions.length > SHOWN) {
        const more = document.createElement('button');
        more.className = 'agent-more';
        more.textContent = `+${sessions.length - SHOWN}`;
        more.title = 'Every agent session';
        more.onclick = () => bridge.agentBoard();
        row.append(more);
    }
    return [row];
}

const overlay = document.createElement('div');
overlay.id = 'agents';
overlay.hidden = true;
overlay.setAttribute('role', 'dialog');
const panel = document.createElement('div');
panel.className = 'panel';
overlay.append(panel);
document.body.append(overlay);
overlay.onclick = event => event.target === overlay && bridge.agentClose();
overlay.onkeydown = event => {
    if (event.key === 'Escape') {
        event.preventDefault();
        bridge.agentClose();
    }
};

let selected = 0;
let board: BoardEntry[] = [];
let renaming: string | undefined;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function show(label: string): void {
    overlay.setAttribute('aria-label', label);
    overlay.hidden = false;
}

/** The board: waiting sessions first; arrows move, Enter jumps, a double click renames, × ends a session. */
function renderBoard(entries: BoardEntry[]): void {
    const wasOpen = !overlay.hidden && overlay.dataset.kind === 'board';
    board = entries;
    selected = Math.min(selected, Math.max(0, entries.length - 1));
    overlay.dataset.kind = 'board';
    const list = element('ul');
    list.setAttribute('role', 'listbox');
    entries.forEach((entry, index) => {
        const item = element('li', `${index === selected ? 'selected' : ''}${entry.active ? ' active' : ''}`);
        item.setAttribute('role', 'option');
        item.style.setProperty('--status', entry.statusColor);
        item.style.setProperty('--session', entry.color);
        const dot = element('span', 'dot');
        dot.title = entry.statusLabel;
        const main = element('div', 'main');
        if (renaming === entry.id) {
            const input = element('input');
            input.value = entry.title;
            input.setAttribute('aria-label', 'Session label');
            const done = (save: boolean) => {
                if (save && input.value.trim() !== entry.title) bridge.agentRename(entry.id, input.value);
                renaming = undefined;
                renderBoard(board);
            };
            input.onkeydown = event => {
                event.stopPropagation();
                if (event.key === 'Enter') done(true);
                if (event.key === 'Escape') done(false);
            };
            input.onblur = () => renaming && done(true);
            main.append(input);
            queueMicrotask(() => input.select());
        } else {
            const title = element('span', 'title', entry.title);
            title.title = 'Double click to rename';
            title.ondblclick = event => {
                event.stopPropagation();
                renaming = entry.id;
                renderBoard(board);
            };
            main.append(title);
        }
        main.append(element('span', 'where', [entry.title !== entry.name ? entry.name : undefined, entry.repoName, entry.workspaceName].filter(Boolean).join(' · ')));
        if (entry.prompt ?? entry.note) main.append(element('span', 'note', entry.prompt?.message ?? entry.note));
        const side = element('div', 'side');
        side.append(element('span', 'status', entry.statusLabel), element('span', 'duration', entry.duration));
        if (entry.prompt && WAITING.has(entry.status)) {
            const answer = element('button', 'action', 'Answer…');
            answer.onclick = event => {
                event.stopPropagation();
                bridge.agentOpenAnswer(entry.id);
            };
            side.append(answer);
        }
        const end = element('button', 'end', '×');
        end.title = entry.status === 'exited' ? 'Close the tab' : 'End the session and its terminal';
        end.setAttribute('aria-label', end.title);
        end.onclick = event => {
            event.stopPropagation();
            bridge.agentEnd(entry.id);
        };
        side.append(end);
        item.append(dot, main, side);
        item.onclick = () => bridge.agentJump(entry.id);
        list.append(item);
    });
    if (!entries.length) list.append(element('li', 'empty', 'No agent sessions. Start one from the Agents menu or the terminal panel.'));
    panel.replaceChildren(element('h2', undefined, 'Agent Sessions'), list);
    show('Agent sessions');
    list.children[selected]?.scrollIntoView({ block: 'nearest' });
    if (!wasOpen || !renaming) panel.tabIndex = -1;
    if (!wasOpen) panel.focus();
}

panel.addEventListener('keydown', event => {
    if (overlay.dataset.kind !== 'board' || renaming || !board.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + board.length) % board.length;
        renderBoard(board);
    } else if (event.key === 'Enter') {
        event.preventDefault();
        bridge.agentJump(board[selected].id);
    }
});

/** The answer form of a waiting session: the buttons write the agent's keys, the field a one line reply. */
function renderAnswer(entry: BoardEntry): void {
    const same = !overlay.hidden && overlay.dataset.kind === 'answer' && overlay.dataset.session === entry.id;
    overlay.dataset.kind = 'answer';
    overlay.dataset.session = entry.id;
    if (same) return;
    const answer = (value: Answer) => bridge.agentAnswer(entry.id, value);
    const heading = element('h2', undefined, `${entry.title} needs input`);
    heading.style.setProperty('--session', entry.color);
    const where = element('p', 'where', [entry.repoName, entry.workspaceName].filter(Boolean).join(' · '));
    const message = element('p', 'message', entry.prompt?.message ?? entry.note ?? 'The agent waits for you.');
    const buttons = element('div', 'row');
    if (entry.prompt?.kind !== 'input') {
        const allow = element('button', 'action primary', 'Allow');
        allow.onclick = () => answer({ kind: 'allow' });
        const deny = element('button', 'action', 'Deny');
        deny.onclick = () => answer({ kind: 'deny' });
        buttons.append(allow, deny);
        for (const option of [1, 2, 3]) {
            const choose = element('button', 'action option', String(option));
            choose.title = `Choose option ${option}`;
            choose.onclick = () => answer({ kind: 'option', option });
            buttons.append(choose);
        }
    }
    const form = element('form', 'row');
    const reply = element('input');
    reply.placeholder = 'Type a reply';
    reply.setAttribute('aria-label', 'Reply to the agent');
    reply.spellcheck = false;
    const send = element('button', 'action', 'Send');
    send.type = 'submit';
    form.append(reply, send);
    form.onsubmit = event => {
        event.preventDefault();
        if (reply.value.trim()) answer({ kind: 'reply', text: reply.value });
    };
    const open = element('button', 'link', 'Open the terminal');
    open.onclick = () => bridge.agentJump(entry.id);
    panel.replaceChildren(heading, where, message, buttons, form, open);
    show(`Answer ${entry.title}`);
    queueMicrotask(() => (entry.prompt?.kind === 'input' ? reply : buttons.querySelector('button') ?? reply).focus());
}

bridge.onAgentBoard(renderBoard);
bridge.onAgentAnswer(renderAnswer);
bridge.onAgentClose(() => {
    overlay.hidden = true;
    renaming = undefined;
    delete overlay.dataset.kind;
    delete overlay.dataset.session;
});

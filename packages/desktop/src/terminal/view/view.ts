/**
 * A repo's terminal panel: the tab bar and one xterm.js per terminal (WebGL renderer; unicode 11 widths, search,
 * web links, sixel and iTerm images, OSC 52 clipboard writes, OSC 8 hyperlinks and file path links). Terminals of
 * hidden tabs keep their xterm, so switching tabs or repos never redraws from scratch. The page knows nothing of the
 * pty host: the main process streams each terminal's snapshot and output through the preload bridge.
 * Bundled with esbuild into `out/terminal/view/view.js`.
 */
import { ClipboardAddon, type IClipboardProvider } from '@xterm/addon-clipboard';
import { FitAddon } from '@xterm/addon-fit';
import { ImageAddon } from '@xterm/addon-image';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal, type IDecoration, type ILink, type IMarker } from '@xterm/xterm';
import { findFileLinks } from '../links.js';
import type { PanelCommand, PanelLayout } from '../view-protocol.js';

interface Bridge {
    layout(): Promise<PanelLayout>;
    onLayout(callback: (layout: PanelLayout) => void): void;
    attach(id: string, cols: number, rows: number): void;
    onSnapshot(callback: (id: string, scrollback: string) => void): void;
    onData(callback: (id: string, data: string) => void): void;
    onExit(callback: (id: string, exit: { code: number, signal?: number }) => void): void;
    onCommand(callback: (command: PanelCommand) => void): void;
    input(id: string, data: string): void;
    resize(id: string, cols: number, rows: number): void;
    create(options: { profile?: string, split?: boolean }): void;
    profileMenu(split: boolean): void;
    agentMenu(): void;
    tabMenu(id: string): void;
    close(id: string): void;
    focus(id: string): void;
    rename(id: string, name: string): void;
    moveTab(id: string, to: number): void;
    hide(): void;
    resizePanel(deltaY: number): void;
    openLink(id: string, uri: string): void;
    resolveFile(id: string, path: string): Promise<string | undefined>;
    openFile(id: string, path: string, line?: number, column?: number): void;
    copy(text: string): void;
    paste(): Promise<string>;
}

const bridge = (window as unknown as { terminals: Bridge }).terminals;
const tabsElement = document.querySelector<HTMLElement>('#tabs')!;
const panesElement = document.querySelector<HTMLElement>('#panes')!;
const emptyElement = document.querySelector<HTMLElement>('#empty')!;
const find = document.querySelector<HTMLFormElement>('#find')!;
const findInput = find.querySelector('input')!;
const findCount = find.querySelector<HTMLElement>('.count')!;

const THEME = {
    background: '#0c0a08', foreground: '#f7f2ea', cursor: '#f7f2ea', cursorAccent: '#0c0a08',
    selectionBackground: '#5cbf6355', scrollbarSliderBackground: '#aaa09233', scrollbarSliderHoverBackground: '#aaa09266',
    black: '#1d1914', red: '#e5684f', green: '#5cbf63', yellow: '#e5c34f', blue: '#6aa5e8', magenta: '#c88fe0', cyan: '#5fc4c0', white: '#d8d0c4',
    brightBlack: '#6b6257', brightRed: '#f08a75', brightGreen: '#7fd685', brightYellow: '#f0d77a', brightBlue: '#8fbcf0', brightMagenta: '#dcaef0', brightCyan: '#86d9d5', brightWhite: '#f7f2ea'
};

interface View {
    id: string;
    term: Terminal;
    fit: FitAddon;
    search: SearchAddon;
    element: HTMLElement;
    /** Output is written only after the snapshot arrived; until then it is part of the snapshot. */
    ready: boolean;
    /** Set by the program through OSC 0 or 2. */
    title?: string;
    /** Prompt starts, for jumping between commands. */
    prompts: IMarker[];
    prompt?: IMarker;
    decorations: IDecoration[];
    /** A bell or a notification while the terminal was not in view. */
    attention: boolean;
    exited: boolean;
}

const views = new Map<string, View>();
const groups = new Map<string, HTMLElement>();
let layout: PanelLayout | undefined;
let editing: string | undefined;

function focusedId(): string | undefined {
    const tab = layout?.tabs.find(t => t.id === layout!.active);
    return tab?.active;
}

function focusedView(): View | undefined {
    const id = focusedId();
    return id ? views.get(id) : undefined;
}

const clipboard: IClipboardProvider = {
    // programs may set the clipboard through OSC 52, never read it
    readText: () => '',
    writeText: (_selection, text) => bridge.copy(text)
};

function createView(id: string): View {
    const settings = layout!.settings;
    const term = new Terminal({
        allowProposedApi: true,
        fontFamily: settings.fontFamily,
        fontSize: settings.fontSize,
        scrollback: settings.scrollback,
        cursorBlink: settings.cursorBlink,
        macOptionIsMeta: false,
        rightClickSelectsWord: layout!.mac,
        drawBoldTextInBrightColors: false,
        overviewRuler: { width: 8 },
        theme: THEME,
        // OSC 8 hyperlinks; like every link they open on Ctrl+click (Cmd+click on macOS), as in VS Code
        linkHandler: { activate: (event, uri) => modifier(event) && bridge.openLink(id, uri), allowNonHttpProtocols: true }
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
    term.loadAddon(new WebLinksAddon((event, uri) => modifier(event) && bridge.openLink(id, uri)));
    term.loadAddon(new ClipboardAddon(undefined, clipboard));
    term.loadAddon(new ImageAddon({ sixelSupport: true, iipSupport: true, storageLimit: 64 }));

    const element = document.createElement('div');
    element.className = 'pane';
    element.dataset.id = id;
    const view: View = { id, term, fit, search, element, ready: false, prompts: [], decorations: [], attention: false, exited: false };
    views.set(id, view);
    // opened once it is in the document, so the renderer can measure
    queueMicrotask(() => openView(view));

    term.onData(data => bridge.input(id, data));
    term.onBinary(data => bridge.input(id, data));
    term.onResize(({ cols, rows }) => view.ready && bridge.resize(id, cols, rows));
    term.onTitleChange(title => {
        view.title = title || undefined;
        renderTabs();
    });
    term.onBell(() => attention(view));
    search.onDidChangeResults(({ resultIndex, resultCount }) => {
        if (focusedView() === view) findCount.textContent = !findInput.value ? '' : resultCount ? `${resultIndex + 1} of ${resultCount}` : 'No results';
    });
    term.textarea?.addEventListener('focus', () => focusedId() !== id && bridge.focus(id));
    element.addEventListener('mousedown', () => focusedId() !== id && bridge.focus(id));
    term.attachCustomKeyEventHandler(event => keys(view, event));
    term.registerLinkProvider({ provideLinks: (line, callback) => provideFileLinks(view, line, callback) });
    // shell integration marks: a prompt starts a command, its exit code colours it in the overview ruler
    term.parser.registerOscHandler(633, data => {
        const kind = data.split(';')[0];
        if (kind === 'A') {
            const marker = term.registerMarker(0);
            if (marker) {
                view.prompt = marker;
                view.prompts.push(marker);
                marker.onDispose(() => view.prompts.splice(view.prompts.indexOf(marker), 1));
            }
        } else if (kind === 'D' && view.prompt) {
            const code = Number(data.split(';')[1]);
            const decoration = term.registerDecoration({
                marker: view.prompt,
                overviewRulerOptions: { color: Number.isFinite(code) && code !== 0 ? THEME.red : THEME.green, position: 'left' }
            });
            if (decoration) view.decorations.push(decoration);
            view.prompt = undefined;
        }
        return true;
    });
    for (const code of [9, 777]) {
        term.parser.registerOscHandler(code, data => {
            if (code === 9 && /^\d+;/.test(data)) return false;
            attention(view);
            return true;
        });
    }
    return view;
}

function modifier(event: MouseEvent): boolean {
    return layout?.mac ? event.metaKey : event.ctrlKey;
}

function openView(view: View): void {
    view.term.open(view.element);
    try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        view.term.loadAddon(webgl);
    } catch {
        // without WebGL xterm.js draws with the DOM renderer
    }
    fitView(view);
    bridge.attach(view.id, view.term.cols, view.term.rows);
}

function fitView(view: View): void {
    if (!view.element.isConnected || view.element.offsetParent === null) return;
    try {
        view.fit.fit();
    } catch {
        // not measurable yet
    }
}

function attention(view: View): void {
    if (focusedId() === view.id && document.hasFocus()) return;
    view.attention = true;
    renderTabs();
}

/** Copy, paste, find and jumping between commands; every other key goes to the program. */
function keys(view: View, event: KeyboardEvent): boolean {
    if (event.type !== 'keydown') return true;
    const mac = layout?.mac ?? false;
    const primary = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && event.shiftKey && !event.metaKey;
    const key = event.key.toLowerCase();
    if (primary && key === 'c' && view.term.hasSelection()) {
        bridge.copy(view.term.getSelection());
        if (!mac) view.term.clearSelection();
        return false;
    }
    if (primary && key === 'c') return !mac;
    if (primary && key === 'v') {
        void paste(view);
        return false;
    }
    if (primary && key === 'f') {
        openFind();
        return false;
    }
    if (primary && key === 'a' && mac) {
        view.term.selectAll();
        return false;
    }
    if (mac && event.metaKey && key === 'k') {
        view.term.clear();
        return false;
    }
    const jump = mac ? event.metaKey && !event.shiftKey : event.ctrlKey && !event.shiftKey && !event.altKey;
    if (jump && (event.key === 'ArrowUp' || event.key === 'ArrowDown') && view.prompts.length) {
        scrollToCommand(view, event.key === 'ArrowUp' ? -1 : 1);
        return false;
    }
    return true;
}

async function paste(view: View): Promise<void> {
    const text = await bridge.paste();
    // bracketed paste is applied by xterm.js when the program asked for it
    if (text) view.term.paste(text);
}

function scrollToCommand(view: View, step: number): void {
    const buffer = view.term.buffer.active;
    const top = buffer.viewportY;
    const lines = view.prompts.map(m => m.line).filter(line => line >= 0);
    const target = step < 0 ? lines.filter(line => line < top).at(-1) : lines.find(line => line > top);
    if (target === undefined) view.term.scrollToBottom();
    else view.term.scrollToLine(target);
}

/** File paths in a line, as links once the main process found the file (relative to the terminal's directory). */
function provideFileLinks(view: View, y: number, callback: (links: ILink[] | undefined) => void): void {
    const line = view.term.buffer.active.getLine(y - 1);
    if (!line) return callback(undefined);
    const text = line.translateToString(true);
    const found = findFileLinks(text).slice(0, 20);
    if (!found.length) return callback(undefined);
    Promise.all(found.map(link => bridge.resolveFile(view.id, link.path).then(path => path ? { link, path } : undefined)))
        .then(results => {
            const links = results.filter(r => r !== undefined).map(({ link, path }): ILink => ({
                range: { start: { x: link.start + 1, y }, end: { x: link.end, y } },
                text: text.slice(link.start, link.end),
                decorations: { underline: true, pointerCursor: true },
                activate: event => modifier(event) && bridge.openFile(view.id, path, link.line, link.column)
            }));
            callback(links.length ? links : undefined);
        }, () => callback(undefined));
}

/** The tab's label: its name (given, else the profile's or program's), with the program the shell runs right now. */
function label(id: string): string {
    const agent = layout?.agents[id];
    if (agent) return agent.title;
    const state = layout?.terminals[id];
    const name = layout?.names[id] ?? state?.name ?? 'terminal';
    const program = state?.running?.command?.trim().split(/\s+/)[0];
    return program && !layout?.names[id] ? `${name}: ${program.split('/').pop()}` : name;
}

function status(id: string): string {
    const state = layout?.terminals[id];
    if (views.get(id)?.attention) return 'attention';
    if (state?.exit) return 'ended';
    if (state?.running) return 'running';
    if (state?.last?.exitCode !== undefined) return state.last.exitCode === 0 ? 'ok' : 'failed';
    return '';
}

function tooltip(id: string): string {
    const state = layout?.terminals[id];
    if (!state) return '';
    const title = views.get(id)?.title;
    const lines = [...title ? [title] : [], `${state.shell} (pid ${state.pid})`, state.cwd];
    if (state.running?.command) lines.push(`Running: ${state.running.command}`);
    else if (state.last) lines.push(`Last: ${state.last.command ?? 'command'} exited with ${state.last.exitCode ?? '?'}`);
    if (state.exit) lines.push(`Ended with code ${state.exit.code}`);
    if (!state.integration && !state.command) lines.push('No shell integration');
    const agent = layout?.agents[id];
    if (agent) lines.unshift(`${agent.title}: ${agent.status}${agent.note ? ` (${agent.note})` : ''}`);
    return lines.join('\n');
}

function renderTabs(): void {
    if (!layout) return;
    tabsElement.replaceChildren(...layout.tabs.map((tab, index) => {
        const button = document.createElement('div');
        button.className = `tab${tab.id === layout!.active ? ' active' : ''}`;
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-selected', String(tab.id === layout!.active));
        button.draggable = true;
        button.title = tab.panes.map(tooltip).join('\n\n');
        const dot = document.createElement('span');
        dot.className = `status ${tab.panes.map(status).find(Boolean) ?? ''}`;
        // an agent session's tab takes its status colour: green working, amber waiting, gray done or exited, red failed
        const agent = tab.panes.map(id => layout!.agents[id]).find(Boolean);
        if (agent) {
            button.classList.add('agent', `agent-${agent.status}`);
            button.style.setProperty('--status', agent.statusColor);
            button.style.setProperty('--session', agent.color);
        }
        button.append(dot);
        if (editing && tab.panes.includes(editing)) {
            const input = document.createElement('input');
            input.value = label(editing);
            const done = (save: boolean) => {
                if (save) bridge.rename(editing!, input.value);
                editing = undefined;
                renderTabs();
            };
            input.addEventListener('keydown', event => {
                if (event.key === 'Enter') done(true);
                if (event.key === 'Escape') done(false);
                event.stopPropagation();
            });
            input.addEventListener('blur', () => editing && done(true));
            button.append(input);
            queueMicrotask(() => input.select());
        } else {
            const text = document.createElement('span');
            text.className = 'label';
            text.textContent = tab.panes.map(label).join(' | ');
            button.append(text);
        }
        const close = document.createElement('button');
        close.className = 'close';
        close.textContent = '×';
        close.title = 'Kill Terminal';
        close.addEventListener('click', event => {
            event.stopPropagation();
            for (const pane of tab.panes) bridge.close(pane);
        });
        button.append(close);
        button.addEventListener('click', () => bridge.focus(tab.active));
        button.addEventListener('dblclick', () => {
            editing = tab.active;
            renderTabs();
        });
        button.addEventListener('auxclick', event => event.button === 1 && tab.panes.forEach(pane => bridge.close(pane)));
        button.addEventListener('contextmenu', event => {
            event.preventDefault();
            bridge.tabMenu(tab.active);
        });
        button.addEventListener('dragstart', event => event.dataTransfer?.setData('text/x-terminal-tab', tab.id));
        button.addEventListener('dragover', event => event.preventDefault());
        button.addEventListener('drop', event => {
            const dragged = event.dataTransfer?.getData('text/x-terminal-tab');
            if (dragged && dragged !== tab.id) bridge.moveTab(dragged, index);
        });
        return button;
    }));
}

function render(next: PanelLayout): void {
    const fontChanged = layout && (layout.settings.fontSize !== next.settings.fontSize || layout.settings.fontFamily !== next.settings.fontFamily);
    layout = next;
    const ids = new Set(next.tabs.flatMap(tab => tab.panes));
    for (const [id, view] of views) {
        if (ids.has(id)) continue;
        view.term.dispose();
        view.element.remove();
        views.delete(id);
    }
    for (const id of ids) if (!views.has(id)) createView(id);
    for (const [id, group] of groups) {
        if (!next.tabs.some(tab => tab.id === id)) {
            group.remove();
            groups.delete(id);
        }
    }
    for (const tab of next.tabs) {
        let group = groups.get(tab.id);
        if (!group) {
            group = document.createElement('div');
            group.className = 'group';
            groups.set(tab.id, group);
        }
        const panes = tab.panes.map(id => views.get(id)!.element);
        if (panes.some((pane, i) => group!.children[i] !== pane) || group.children.length !== panes.length) group.replaceChildren(...panes);
        group.classList.toggle('split', tab.panes.length > 1);
        group.hidden = tab.id !== next.active;
        for (const pane of panes) pane.classList.toggle('focused', pane.dataset.id === tab.active);
        if (!group.isConnected) panesElement.append(group);
    }
    for (const [id, view] of views) {
        const state = next.terminals[id];
        if (fontChanged) {
            view.term.options.fontSize = next.settings.fontSize;
            view.term.options.fontFamily = next.settings.fontFamily;
        }
        view.term.options.cursorBlink = next.settings.cursorBlink;
        if (state?.exit && !view.exited && view.ready) showExit(view, state.exit);
    }
    const focused = focusedView();
    if (focused?.attention) focused.attention = false;
    emptyElement.hidden = next.tabs.length > 0;
    renderTabs();
    requestAnimationFrame(() => {
        for (const view of views.values()) fitView(view);
        focusedView()?.term.focus();
    });
}

function showExit(view: View, exit: { code: number, signal?: number }): void {
    view.exited = true;
    view.term.write(`\r\n\x1b[2m[The process ended with code ${exit.code}${exit.signal ? `, signal ${exit.signal}` : ''}. Close the tab to remove it.]\x1b[0m\r\n`);
}

function openFind(): void {
    find.hidden = false;
    findInput.select();
    findInput.focus();
}

function closeFind(): void {
    find.hidden = true;
    findCount.textContent = '';
    focusedView()?.search.clearDecorations();
    focusedView()?.term.focus();
}

function findStep(step: number): void {
    const view = focusedView();
    if (!view || !findInput.value) return;
    const decorations = { matchOverviewRuler: '#e5c34f', activeMatchColorOverviewRuler: '#5cbf63', matchBackground: '#e5c34f44', activeMatchBackground: '#5cbf6388' };
    const options = { decorations, incremental: step === 0 };
    if (step < 0) view.search.findPrevious(findInput.value, options);
    else view.search.findNext(findInput.value, options);
}

findInput.addEventListener('input', () => findStep(0));
findInput.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeFind();
    else if (event.key === 'Enter') {
        event.preventDefault();
        findStep(event.shiftKey ? -1 : 1);
    }
});
find.addEventListener('submit', event => event.preventDefault());
find.querySelectorAll<HTMLButtonElement>('[data-step]').forEach(button => button.addEventListener('click', () => findStep(Number(button.dataset.step))));
find.querySelector('[data-close]')!.addEventListener('click', closeFind);

bridge.onSnapshot((id, scrollback) => {
    const view = views.get(id);
    if (!view) return;
    view.term.reset();
    view.term.write(scrollback);
    view.ready = true;
    const exit = layout?.terminals[id]?.exit;
    if (exit && !view.exited) showExit(view, exit);
});
bridge.onData((id, data) => {
    const view = views.get(id);
    if (view?.ready) view.term.write(data);
});
bridge.onExit((id, exit) => {
    const view = views.get(id);
    if (view?.ready && !view.exited) showExit(view, exit);
});
bridge.onLayout(render);
bridge.onCommand(command => {
    const view = focusedView();
    if (command === 'find') return openFind();
    if (!view) return;
    if (command === 'clear') view.term.clear();
    else if (command === 'selectAll') view.term.selectAll();
    else if (command === 'copy' && view.term.hasSelection()) bridge.copy(view.term.getSelection());
    else if (command === 'paste') void paste(view);
    else if (command === 'previousCommand') scrollToCommand(view, -1);
    else if (command === 'nextCommand') scrollToCommand(view, 1);
    else if (command === 'focus') view.term.focus();
});

document.querySelector('#new')!.addEventListener('click', () => bridge.create({}));
document.querySelector('#start')!.addEventListener('click', () => bridge.create({}));
document.querySelector('#profiles')!.addEventListener('click', () => bridge.profileMenu(false));
document.querySelector('#agent')!.addEventListener('click', () => bridge.agentMenu());
document.querySelector('#start-agent')!.addEventListener('click', () => bridge.agentMenu());
document.querySelector('#split')!.addEventListener('click', () => bridge.create({ split: true }));
document.querySelector('#kill')!.addEventListener('click', () => {
    const id = focusedId();
    if (id) bridge.close(id);
});
document.querySelector('#hide')!.addEventListener('click', () => bridge.hide());
tabsElement.addEventListener('dblclick', event => event.target === tabsElement && bridge.create({}));

// dragging the top edge resizes the panel; the main process moves the boundary
const grip = document.querySelector<HTMLElement>('#grip')!;
grip.addEventListener('pointerdown', event => {
    grip.setPointerCapture(event.pointerId);
    grip.classList.add('dragging');
    let last = event.screenY;
    const move = (e: PointerEvent) => {
        bridge.resizePanel(e.screenY - last);
        last = e.screenY;
    };
    const up = () => {
        grip.classList.remove('dragging');
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
});

new ResizeObserver(() => {
    for (const view of views.values()) fitView(view);
}).observe(panesElement);
window.addEventListener('focus', () => {
    const view = focusedView();
    if (view?.attention) {
        view.attention = false;
        renderTabs();
    }
});

bridge.layout().then(render);

import { join } from 'node:path';
import type { PanelAction, PanelName, PanelState } from '@appling/inspect/panels';
import { diffMessage, openMessage } from '@appling/inspect/host-requests';
import { GraphIndex, kindLabel } from '@appling/viz/views';
import {
    commands, EventEmitter, FileDecoration, ThemeColor, ThemeIcon, TreeItem, TreeItemCollapsibleState, Uri, ViewColumn, window, workspace, type Disposable, type TextDocumentContentProvider, type TreeDataProvider, type TreeView
} from 'vscode';
import { openDiff, openLines, revealOffsets } from './editor.js';
import { diffSummary, inspected, PANEL_TREES, VERBS, VIEWS, type ChangeStatus, type PanelNode, type Run, type ViewName } from './panel-trees.js';

/** What the panels need from the inspector tabs. */
export interface PanelsHost {
    /** Sends an event to the project's inspector client. */
    post(root: string, event: { type: 'element', qn: string } | { type: 'panel', action: PanelAction }): void;
}

const BASELINE = 'appling-baseline';
/** The scheme of the panels' items: their file icons, and the change decorations below instead of git's. */
const ITEM = 'appling-panel';
/** How Source Control marks a change: its letter and colour. */
const DECORATIONS: Record<ChangeStatus, [string, string]> = {
    added: ['A', 'gitDecoration.addedResourceForeground'], changed: ['M', 'gitDecoration.modifiedResourceForeground'],
    modified: ['M', 'gitDecoration.modifiedResourceForeground'], removed: ['D', 'gitDecoration.deletedResourceForeground'],
    deleted: ['D', 'gitDecoration.deletedResourceForeground'], renamed: ['R', 'gitDecoration.renamedResourceForeground'],
    untracked: ['U', 'gitDecoration.untrackedResourceForeground']
};

/**
 * The inspector's side panels as native views in the Appling sidebar (`appling.inspector`, `.playbook`, `.changes`, `.review`,
 * `.code`, `.tasks`; search is VS Code's Go to Symbol in Workspace), showing the inspector tab last active, read only:
 * its client sends the state, the trees come from `panel-trees.ts`, and what the user does goes back to the client as
 * an action, or happens here (opening files and diffs).
 */
export class Panels implements Disposable {
    private readonly states = new Map<string, { state: PanelState, index: GraphIndex }>();
    private readonly trees = {} as Record<ViewName, { view: TreeView<PanelNode>, changed: EventEmitter<void> }>;
    private readonly disposables: Disposable[] = [];
    private active?: string;

    constructor(private readonly host: PanelsHost) {
        for (const name of VIEWS) {
            const changed = new EventEmitter<void>();
            const provider: TreeDataProvider<PanelNode> = {
                onDidChangeTreeData: changed.event,
                getChildren: node => node ? node.children ?? [] : this.build(name),
                getTreeItem: node => this.item(node)
            };
            const view = window.createTreeView(`appling.${name}`, { treeDataProvider: provider, showCollapseAll: name !== 'inspector' });
            this.trees[name] = { view, changed };
            this.disposables.push(view, changed);
        }
        this.trees.review.view.onDidChangeVisibility(event => { if (event.visible) this.act({ type: 'review', on: true }); });
        const baseline: TextDocumentContentProvider = { provideTextDocumentContent: uri => this.baseline(uri) };
        const command = (id: string, run: (...args: never[]) => unknown) => commands.registerCommand(id, run);
        this.disposables.push(
            workspace.registerTextDocumentContentProvider(BASELINE, baseline),
            window.registerFileDecorationProvider({
                provideFileDecoration: uri => {
                    const decoration = uri.scheme === ITEM && DECORATIONS[uri.query as ChangeStatus];
                    return decoration ? new FileDecoration(decoration[0], uri.query, new ThemeColor(decoration[1])) : undefined;
                }
            }),
            command('appling.panel.run', (run: Run) => this.run(run)),
            ...VERBS.map(verb => command(`appling.panel.${verb}`, (node: PanelNode) => node.actions?.[verb] && this.run(node.actions[verb]!))),
            command('appling.inspector.openSource', () => this.selected() && this.run({ type: 'source', qn: this.selected()! })),
            command('appling.inspector.openCode', () => this.openCode()),
            command('appling.review.compare', () => this.compare()),
            command('appling.review.mark', () => this.act({ type: 'review', marked: true })),
            command('appling.review.unmark', () => this.act({ type: 'review', marked: false }))
        );
    }

    /** The client of the project's inspector tab sent its state. */
    update(root: string, state: PanelState): void {
        const previous = this.states.get(root);
        const index = previous && previous.state.snapshot.graph === state.snapshot.graph ? previous.index : new GraphIndex(state.snapshot.graph);
        this.states.set(root, { state, index });
        this.active ??= root;
        if (root === this.active) this.refresh();
    }

    /** The inspector tab of the project became active: the panels show it. */
    activate(root: string): void {
        if (this.active === root) return;
        this.active = root;
        this.refresh();
    }

    /** The project's inspector tab closed. */
    remove(root: string): void {
        this.states.delete(root);
        if (this.active === root) this.active = this.states.keys().next().value;
        this.refresh();
    }

    show(name: PanelName): void {
        if ((VIEWS as readonly string[]).includes(name)) void commands.executeCommand(`appling.${name}.focus`);
    }

    dispose(): void {
        for (const disposable of this.disposables) disposable.dispose();
    }

    private current(): { root: string, state: PanelState, index: GraphIndex } | undefined {
        const entry = this.active ? this.states.get(this.active) : undefined;
        return entry && { root: this.active!, ...entry };
    }

    private selected(): string | undefined {
        const current = this.current();
        return current && inspected(current.state, current.index).qn;
    }

    private build(name: ViewName): PanelNode[] {
        const current = this.current();
        return current ? PANEL_TREES[name](current.state, current.index) : [];
    }

    private item(node: PanelNode): TreeItem {
        const collapse = node.children?.length ? node.expanded ? TreeItemCollapsibleState.Expanded : TreeItemCollapsibleState.Collapsed : TreeItemCollapsibleState.None;
        const item = new TreeItem(node.label, collapse);
        item.id = node.id;
        item.description = node.description;
        item.tooltip = node.tooltip;
        if (node.file || node.status) item.resourceUri = Uri.from({ scheme: ITEM, path: `/${node.file ?? node.id}`, query: node.status ?? '' });
        if (node.icon) item.iconPath = new ThemeIcon(node.icon, node.color ? new ThemeColor(node.color) : undefined);
        item.contextValue = Object.keys(node.actions ?? {}).join(' ');
        if (node.run) item.command = { command: 'appling.panel.run', title: node.label, arguments: [node.run] };
        return item;
    }

    private refresh(): void {
        const current = this.current();
        void commands.executeCommand('setContext', 'appling.inspect', this.states.size > 0);
        for (const name of VIEWS) this.trees[name].changed.fire();
        if (!current) return;
        const { state, index } = current;
        const qn = inspected(state, index).qn;
        const node = qn ? index.nodes.get(qn) : undefined;
        const context: Record<string, boolean> = {
            'appling.inspector.element': !!node,
            'appling.inspector.code': !!qn && (state.snapshot.code[qn]?.length ?? 0) > 0,
            'appling.review.marked': state.review.marked
        };
        for (const [key, value] of Object.entries(context)) void commands.executeCommand('setContext', key, value);
        const badge = (count: number, what: string) => count ? { value: count, tooltip: `${count} ${what}` } : undefined;
        this.trees.changes.view.badge = badge(state.live?.files.length ?? 0, 'changed model files');
        this.trees.playbook.view.badge = badge(state.playbooks.length, 'playbooks');
        this.trees.tasks.view.badge = badge(state.snapshot.tasks.filter(t => t.status !== 'done').length, 'open registry tasks');
        this.trees.tasks.view.description = state.snapshot.targets.length ? undefined : 'no stack yet';
        this.trees.changes.view.description = state.live?.files.length ? diffSummary(state.live.diff) : undefined;
        const review = state.review.result;
        this.trees.review.view.description = review?.ok ? `since ${review.commit.slice(0, 7)}${state.review.rev === 'HEAD' ? ' (uncommitted)' : ''}` : undefined;
        this.trees.inspector.view.description = node && kindLabel(node.kind);
    }

    private act(action: PanelAction): void {
        if (this.active) this.host.post(this.active, { type: 'panel', action });
    }

    private async run(run: Run): Promise<void> {
        const current = this.current();
        if (!current) return;
        const { root, state } = current;
        try {
            switch (run.type) {
                case 'action': return this.act(run.action);
                case 'source': {
                    const location = state.snapshot.locations[run.qn];
                    if (location) await revealOffsets(Uri.parse(location.uri), location.start, location.end, ViewColumn.Beside);
                    return;
                }
                case 'code': {
                    const open = openMessage(root, { path: run.path, start: run.start, end: run.end });
                    if (open) await openLines(open.path, open.start, open.end, ViewColumn.Beside);
                    return;
                }
                case 'textDiff': {
                    if (state.review.on && state.review.marked && state.review.result?.ok) return this.act({ type: 'textDiff', qn: run.qn });
                    const file = state.live?.files.find(f => f.elements.includes(run.qn));
                    if (file) await this.run({ type: 'liveDiff', path: file.path });
                    return;
                }
                case 'liveDiff': {
                    const file = state.live?.files.find(f => f.path === run.path);
                    if (!file) return;
                    const before = Uri.from({ scheme: BASELINE, path: join(root, file.path), query: 'before' });
                    const after = file.after === null ? Uri.from({ scheme: BASELINE, path: join(root, file.path), query: 'after' }) : Uri.file(join(root, file.path));
                    await commands.executeCommand('vscode.diff', before, after, `${file.path} (changed)`, { viewColumn: ViewColumn.Beside });
                    return;
                }
                case 'reviewDiff': {
                    const result = state.review.result;
                    const diff = result?.ok && diffMessage(root, { path: run.path, rev: result.commit, ...run.from ? { before: run.from } : {} });
                    if (diff) await openDiff(diff.path, diff.before, diff.rev, diff.line, ViewColumn.Beside);
                    return;
                }
            }
        } catch (error) {
            window.showErrorMessage(`Appling: ${(error as Error).message}`);
        }
    }

    private openCode(): void {
        const current = this.current();
        const qn = this.selected();
        const references = qn ? current?.state.snapshot.code[qn] ?? [] : [];
        const reference = references.find(c => c.status !== 'broken') ?? references[0];
        if (reference) void this.run({ type: 'code', path: reference.file, start: reference.start, end: reference.end });
    }

    private async compare(): Promise<void> {
        const review = this.current()?.state.review;
        if (!review) return;
        const picked = await window.showQuickPick([
            { label: 'HEAD', description: 'uncommitted changes', rev: 'HEAD' },
            ...review.revisions.map(r => ({ label: r.short, description: `${r.subject} · ${r.date}`, rev: r.hash }))
        ], { placeHolder: 'Compare the working tree with' });
        if (picked) this.act({ type: 'review', on: true, rev: picked.rev });
    }

    /** A live changed file's text at the baseline (`?before`), or an empty text for a deleted one (`?after`). */
    private baseline(uri: Uri): string {
        if (uri.query !== 'before') return '';
        for (const [root, { state }] of this.states) {
            const file = state.live?.files.find(f => join(root, f.path) === uri.path);
            if (file) return file.before ?? '';
        }
        return '';
    }
}

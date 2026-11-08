import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { GenerationSelection } from '@appling/codegen';
import { STACK_LABELS, STACKS, type Stack } from '@appling/codegen/stacks';
import type { PanelAction, PanelName, PanelState } from '@appling/ide/panels';
import { diffMessage, openMessage } from '@appling/ide/host-requests';
import type { EditOperation } from '@appling/model';
import { GraphIndex, kindLabel } from '@appling/viz/views';
import {
    commands, EventEmitter, FileDecoration, Range, ThemeColor, ThemeIcon, TreeItem, TreeItemCheckboxState, TreeItemCollapsibleState, Uri, ViewColumn, window, workspace,
    WorkspaceEdit, type Disposable, type TextDocumentContentProvider, type TreeDataProvider, type TreeView
} from 'vscode';
import { openDiff, openLines, revealOffsets } from './editor.js';
import { diffSummary, inspected, PANEL_TREES, VERBS, VIEWS, type ChangeStatus, type PanelNode, type Run, type ViewName } from './panel-trees.js';

/** What the panels need from the IDE tabs. */
export interface PanelsHost {
    /** Sends an event to the project's IDE client. */
    post(root: string, event: { type: 'element', qn: string } | { type: 'panel', action: PanelAction }): void;
    /** The project's IDE server, while it runs. */
    server(root: string): string | undefined;
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
const TYPED = new Set(['Field', 'Param']);

/**
 * The IDE's side panels as native views in the Appling sidebar (`appling.inspector`, `.changes`, `.playbook`, `.review`,
 * `.code`; search is VS Code's Go to Symbol in Workspace), showing the IDE tab last active: its client sends the state, the trees come from
 * `panel-trees.ts`, and what the user does goes back to the client as an action, or happens here (opening files and
 * diffs, inspector edits as VS Code edits through the server's `/api/edit`).
 */
export class Panels implements Disposable {
    private readonly states = new Map<string, { state: PanelState, index: GraphIndex }>();
    private readonly trees = {} as Record<ViewName, { view: TreeView<PanelNode>, changed: EventEmitter<void> }>;
    private readonly checked = new Set<string>();
    private readonly log = window.createOutputChannel('Appling Generation');
    private readonly disposables: Disposable[] = [this.log];
    private active?: string;

    constructor(private readonly host: PanelsHost) {
        for (const name of VIEWS) {
            const changed = new EventEmitter<void>();
            const provider: TreeDataProvider<PanelNode> = {
                onDidChangeTreeData: changed.event,
                getChildren: node => node ? node.children ?? [] : this.build(name),
                getTreeItem: node => this.item(node)
            };
            const view = window.createTreeView(`appling.${name}`, { treeDataProvider: provider, showCollapseAll: name !== 'inspector', manageCheckboxStateManually: true });
            this.trees[name] = { view, changed };
            this.disposables.push(view, changed);
        }
        this.trees.code.view.onDidChangeCheckboxState(event => {
            for (const [node, state] of event.items) {
                if (state === TreeItemCheckboxState.Checked) this.checked.add(node.id);
                else this.checked.delete(node.id);
            }
        });
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
            command('appling.inspector.rename', () => this.rename()),
            command('appling.inspector.retype', () => this.retype()),
            command('appling.inspector.add', () => this.addMember()),
            command('appling.inspector.remove', () => this.removeElement()),
            command('appling.changes.acceptAll', () => this.act({ type: 'accept' })),
            command('appling.playbook.play', () => this.play()),
            command('appling.review.compare', () => this.compare()),
            command('appling.review.mark', () => this.act({ type: 'review', marked: true })),
            command('appling.review.unmark', () => this.act({ type: 'review', marked: false })),
            command('appling.code.generate', () => this.generate())
        );
    }

    /** The client of the project's IDE tab sent its state. */
    update(root: string, state: PanelState): void {
        const previous = this.states.get(root);
        const index = previous && previous.state.snapshot.graph === state.snapshot.graph ? previous.index : new GraphIndex(state.snapshot.graph);
        this.states.set(root, { state, index });
        this.active ??= root;
        if (root === this.active) this.refresh();
    }

    /** The IDE tab of the project became active: the panels show it. */
    activate(root: string): void {
        if (this.active === root) return;
        this.active = root;
        this.refresh();
    }

    /** The project's IDE tab closed. */
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
        if (node.checked !== undefined) item.checkboxState = this.checked.has(node.id) ? TreeItemCheckboxState.Checked : TreeItemCheckboxState.Unchecked;
        return item;
    }

    private refresh(): void {
        const current = this.current();
        void commands.executeCommand('setContext', 'appling.ide', this.states.size > 0);
        for (const name of VIEWS) this.trees[name].changed.fire();
        if (!current) return;
        const { state, index } = current;
        const qn = inspected(state, index).qn;
        const node = qn ? index.nodes.get(qn) : undefined;
        const parent = qn ? index.parent(qn) : undefined;
        const context: Record<string, boolean> = {
            'appling.inspector.element': !!node,
            'appling.inspector.named': !!node && node.kind !== 'Module' && /^[_a-zA-Z]\w*$/.test(qn!.slice((parent?.length ?? -1) + 1)),
            'appling.inspector.typed': !!node && TYPED.has(node.kind),
            'appling.inspector.removable': !!node && (node.kind !== 'Module' || !!parent),
            'appling.inspector.code': !!qn && (state.snapshot.code[qn]?.length ?? 0) > 0,
            'appling.review.marked': state.review.marked
        };
        for (const [key, value] of Object.entries(context)) void commands.executeCommand('setContext', key, value);
        const live = (state.live?.files.length ?? 0) + state.proposals.length;
        const unwatched = state.playbook?.chapters.filter(c => c.seen === undefined || c.seen < c.steps.length).length ?? 0;
        const badge = (count: number, what: string) => count ? { value: count, tooltip: `${count} ${what}` } : undefined;
        this.trees.changes.view.badge = badge(live, 'unseen changes and proposals');
        this.trees.playbook.view.badge = badge(unwatched, 'unwatched chapters');
        this.trees.tasks.view.badge = badge(state.snapshot.tasks.length, 'open registry tasks');
        this.trees.tasks.view.description = state.snapshot.targets.length ? undefined : 'no stack yet';
        this.trees.changes.view.description = state.live?.files.length ? diffSummary(state.live.diff) : undefined;
        const review = state.review.result;
        this.trees.review.view.description = review?.ok ? `since ${review.commit.slice(0, 7)}${state.review.rev === 'HEAD' ? ' (uncommitted)' : ''}` : undefined;
        this.trees.inspector.view.description = node && kindLabel(node.kind);
        this.trees.code.view.description = state.run && !state.run.ended ? 'generating' : undefined;
        this.log.replace((state.run?.events ?? []).flatMap(e => e.type === 'log' ? [`${e.target}: ${e.line}`] : []).join('\n'));
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
                    await commands.executeCommand('vscode.diff', before, after, `${file.path} (since last accepted)`, { viewColumn: ViewColumn.Beside });
                    return;
                }
                case 'reviewDiff': {
                    const result = state.review.result;
                    const diff = result?.ok && diffMessage(root, { path: run.path, rev: result.commit, ...run.from ? { before: run.from } : {} });
                    if (diff) await openDiff(diff.path, diff.before, diff.rev, diff.line, ViewColumn.Beside);
                    return;
                }
                case 'reject': {
                    const comment = await window.showInputBox({ title: 'Reject the proposal', prompt: 'A comment for the agent (optional)' });
                    if (comment !== undefined) this.act({ type: 'decide', id: run.proposal, decision: { accepted: false, ...comment.trim() ? { comment: comment.trim() } : {} } });
                    return;
                }
                case 'line': {
                    const lines = [...run.lines];
                    if (run.remove && run.line !== undefined) lines.splice(run.line, 1);
                    else {
                        const value = await window.showInputBox({ title: `${run.qn}: ${run.property}`, value: run.line === undefined ? '' : lines[run.line], prompt: run.line === undefined ? 'The line to add' : undefined });
                        if (value === undefined || (run.line === undefined && !value.trim())) return;
                        if (run.line === undefined) lines.push(value);
                        else lines[run.line] = value;
                    }
                    return void await this.edit({ op: 'set', target: run.qn, property: run.property, value: lines.join(run.separator) });
                }
                case 'log': return this.log.show(true);
                case 'stack': if (this.active) await this.chooseStack(this.active, run.selection); return;
            }
        } catch (error) {
            window.showErrorMessage(`Appling: ${(error as Error).message}`);
        }
    }

    /** Runs an edit operation on the texts of VS Code's documents (unsaved ones as they are), applies and saves it. */
    private async edit(operation: EditOperation): Promise<boolean> {
        const current = this.current();
        const server = current && this.host.server(current.root);
        if (!current || !server) return false;
        const documents = await Promise.all(current.state.snapshot.files.map(f => workspace.openTextDocument(Uri.parse(f.uri))));
        const sources = Object.fromEntries(documents.map((d, i) => [current.state.snapshot.files[i].uri, d.getText()]));
        const response = await fetch(`${server}/api/edit`, { method: 'POST', body: JSON.stringify({ sources, operation }) });
        const result = await response.json() as { ok: true, edits: { uri: string, offset: number, length: number, text: string }[] } | { ok: false, errors: string[] };
        if (!result.ok) {
            window.showErrorMessage(`Appling did not ${operation.op} it: ${result.errors.join('; ')}`);
            return false;
        }
        const edit = new WorkspaceEdit();
        const touched = new Set<string>();
        for (const e of result.edits) {
            const document = documents[current.state.snapshot.files.findIndex(f => f.uri === e.uri)];
            if (!document) continue;
            edit.replace(document.uri, new Range(document.positionAt(e.offset), document.positionAt(e.offset + e.length)), e.text);
            touched.add(e.uri);
        }
        if (!await workspace.applyEdit(edit)) return false;
        await Promise.all(documents.filter((_, i) => touched.has(current.state.snapshot.files[i].uri)).map(d => d.save()));
        return true;
    }

    private openCode(): void {
        const current = this.current();
        const qn = this.selected();
        const references = qn ? current?.state.snapshot.code[qn] ?? [] : [];
        const reference = references.find(c => c.status !== 'broken') ?? references[0];
        if (reference) void this.run({ type: 'code', path: reference.file, start: reference.start, end: reference.end });
    }

    private async rename(): Promise<void> {
        const qn = this.selected();
        if (!qn) return;
        const parent = this.current()!.index.parent(qn);
        const name = await window.showInputBox({ title: `Rename ${qn}`, value: qn.slice((parent?.length ?? -1) + 1) });
        if (name && await this.edit({ op: 'rename', target: qn, name })) this.select(`${qn.slice(0, qn.lastIndexOf('.') + 1)}${name}`);
    }

    private async retype(): Promise<void> {
        const qn = this.selected();
        const node = qn ? this.current()!.index.nodes.get(qn) : undefined;
        if (!qn || !node) return;
        const type = await window.showInputBox({ title: `The type of ${qn}`, value: String(node.props.type ?? '') });
        if (type) await this.edit({ op: 'retype', target: qn, type });
    }

    private async addMember(): Promise<void> {
        const qn = this.selected();
        const node = qn ? this.current()!.index.nodes.get(qn) : undefined;
        if (!qn || !node) return;
        const source = await window.showInputBox({ title: `Add a member to ${qn}`, placeHolder: node.kind === 'Module' ? 'entity Customer { name: String }' : 'note: Text?' });
        if (source?.trim()) await this.edit({ op: 'add', parent: qn, source });
    }

    private async removeElement(): Promise<void> {
        const qn = this.selected();
        if (!qn) return;
        const sure = await window.showWarningMessage(`Remove ${qn} from the model?`, { modal: true }, 'Remove');
        if (sure && await this.edit({ op: 'remove', target: qn })) {
            const parent = qn.slice(0, qn.lastIndexOf('.'));
            if (parent) this.select(parent);
        }
    }

    private select(qn: string): void {
        if (this.active) this.host.post(this.active, { type: 'element', qn });
    }

    /** Play or resume: where the user is, else the first unwatched chapter. */
    private play(): void {
        const playbook = this.current()?.state.playbook;
        if (!playbook?.chapters.length) return;
        const first = playbook.chapters.find(c => c.seen === undefined || c.seen < c.steps.length) ?? playbook.chapters[0];
        this.act({ type: 'play', position: playbook.position.chapter ? playbook.position : { chapter: first.id, step: 0 } });
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

    private async generate(): Promise<void> {
        const current = this.current();
        if (!current) return;
        const { state, index } = current;
        if (state.run && !state.run.ended) return void window.showInformationMessage('Appling: a generation is running.');
        const outstanding = Object.values(state.snapshot.implementation).filter(i => i.outstanding).length;
        const qn = inspected(state, index).qn;
        const checked = [...this.checked].filter(id => id.startsWith('outstanding/')).map(id => id.slice('outstanding/'.length));
        const choices: { label: string, description?: string, selection: GenerationSelection }[] = !state.snapshot.targets.some(t => t.generated) ? [{ label: 'Generate the application', description: 'from the whole model; then elements one by one', selection: { mode: 'all' as const } }] : [
            ...outstanding ? [{ label: `Generate ${outstanding} outstanding`, selection: { mode: 'outstanding' as const } }] : [],
            ...qn ? [{ label: `Generate ${qn}`, selection: { mode: 'elements' as const, elements: [qn] } }] : [],
            ...checked.length ? [{ label: `Generate ${checked.length} checked`, selection: { mode: 'elements' as const, elements: checked } }] : [],
            { label: 'Generate everything', selection: { mode: 'all' as const } }
        ];
        const picked = await window.showQuickPick(choices, { placeHolder: 'What to generate' });
        if (!picked) return;
        if (state.snapshot.targets.length) this.act({ type: 'generate', selection: picked.selection });
        else await this.chooseStack(current.root, picked.selection);
    }

    /**
     * Generation without a target: the stack to generate with becomes the target of appling.config.json, then the
     * selection generates (the first run creates the whole application). The generator comes with the extension;
     * installing it into the project with npm pins its version there, which then wins.
     */
    async chooseStack(root: string, selection: GenerationSelection): Promise<void> {
        const server = this.host.server(root);
        const picked = await window.showQuickPick((Object.keys(STACKS) as Stack[]).map(stack => ({ label: STACK_LABELS[stack], description: STACKS[stack], stack })), {
            placeHolder: 'Generate the application with which stack? It is added to appling.config.json.'
        });
        if (!picked || !server) return;
        const response = await fetch(`${server}/api/targets`, { method: 'POST', body: JSON.stringify({ stack: picked.stack }) });
        if (!response.ok) return void window.showErrorMessage(`Appling: ${await response.text()}`);
        this.host.post(root, { type: 'panel', action: { type: 'generate', selection } });
        const name = STACKS[picked.stack];
        try {
            createRequire(join(root, 'appling.config.json')).resolve(name);
        } catch {
            const install = 'Install with npm';
            const answer = await window.showInformationMessage(`Appling: generating with the ${STACK_LABELS[picked.stack]} generator that comes with the extension. Install ${name} into the project to pin its version?`, install);
            if (answer !== install) return;
            const terminal = window.createTerminal({ name: `Install ${name}`, cwd: root });
            terminal.show();
            terminal.sendText(`npm install --save-dev ${name}`);
        }
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

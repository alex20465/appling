import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { MemoryPlaybookStore, MemorySessionStore, type AppHost } from '@appling/ai';
import { startIdeProcess, type CodeMarks, type IdeProcess } from '@appling/ide/process';
import {
    commands, env, EventEmitter, ThemeIcon, TreeItem, TreeItemCollapsibleState, Uri, ViewColumn, window, workspace,
    type Disposable, type ExtensionContext, type TreeDataProvider, type WebviewPanel
} from 'vscode';
import { openDiff, openLines, revealOffsets } from './editor.js';
import { clientUrl, panelAction, panelHtml } from './frame.js';
import type { ImplementationState } from './implementation.js';
import { ImplementationView } from './implementation-view.js';
import { Panels } from './panels.js';
import type { PanelAction } from '@appling/ide/panels';
import { projectOf, projectRoots } from './projects.js';

/** What the IDE client is told: select an element, the element at a model file's offset, show the Changes tab, a panel's action. */
type FrameEvent = { type: 'element', qn: string } | { type: 'cursor', uri: string, offset: number } | { type: 'showChanges', session?: string } | { type: 'panel', action: PanelAction };

interface Project {
    root: string;
    ide?: IdeProcess;
    /** Set while the server starts or after it failed. */
    starting?: Promise<IdeProcess>;
    error?: string;
    modules: string[];
    errors?: number;
    marks?: CodeMarks;
    /** Whether it has an `appling.config.json`, which `appling init` writes; without one the extension suggests init. */
    setUp?: boolean;
}

/** The projects whose init suggestion was declined for good, in the workspace state. */
const DECLINED = 'appling.initDeclined';

/** What the workbench needs from the agent sessions. */
export interface AgentHost {
    focus(session: string): boolean;
    tabs(): { id: string, title: string, kind: string, repo?: string, active?: boolean }[];
}

/**
 * Appling in a plain VS Code window (Desktop's code view has its own canvas): the Appling projects of the workspace,
 * one IDE server per project (`@appling/ide`, sharing one session and playbook store, as Desktop's repos do), the
 * Projects view with each project's modules, the IDE tab per project (the IDE client in a webview, without its own
 * source pane), the jump from a `.appling` editor into the IDE, the implementation marks and code links in the
 * editor, and `Initialize Appling` (`appling init` in a terminal).
 */
export class Workbench implements Disposable {
    readonly store = new MemorySessionStore();
    readonly playbooks: MemoryPlaybookStore;
    readonly workspaceId = workspaceId();
    private readonly projects = new Map<string, Project>();
    private readonly panels = new Map<string, WebviewPanel>();
    private readonly changed = new EventEmitter<void>();
    private readonly disposables: Disposable[] = [];
    private readonly implementation: ImplementationView;
    private readonly sidePanels: Panels;
    private agents?: AgentHost;
    private active?: string;
    /** A folder `appling init` runs in: its IDE opens once it is a project. */
    private initializing?: string;

    constructor(private readonly context: ExtensionContext) {
        this.playbooks = new MemoryPlaybookStore(join(context.globalStorageUri.fsPath, 'playbooks'));
        this.implementation = new ImplementationView(qn => this.showElement(qn));
        this.sidePanels = new Panels({
            post: (root, event) => void this.panels.get(root)?.webview.postMessage(event),
            server: root => this.projects.get(root)?.ide?.url
        });
        this.disposables.push(this.sidePanels);
        const watcher = workspace.createFileSystemWatcher('**/{*.appling,appling.config.json}', false, true, false);
        this.disposables.push(
            this.implementation, watcher, this.changed,
            watcher.onDidCreate(() => void this.refresh()),
            watcher.onDidDelete(() => void this.refresh()),
            workspace.onDidChangeWorkspaceFolders(() => void this.refresh()),
            window.registerTreeDataProvider('appling.projects', new ProjectsTree(this)),
            commands.registerCommand('appling.openIde', (root?: string, qn?: string) => this.openIde(root, qn)),
            commands.registerCommand('appling.openInIde', (uri?: Uri) => this.openInIde(uri)),
            commands.registerCommand('appling.init', (target?: string | Project) => this.init(target)),
            commands.registerCommand('appling.refresh', () => this.refresh())
        );
    }

    /** The agent sessions, for the IDE's jumps to a session and their IDE context. */
    attach(agents: AgentHost): void {
        this.agents = agents;
    }

    readonly onDidChange = this.changed.event;

    list(): Project[] {
        return [...this.projects.values()].sort((a, b) => a.root.localeCompare(b.root));
    }

    /** The MCP endpoint of a project's IDE server, while it runs. */
    mcp(root: string): string | undefined {
        return this.projects.get(root)?.ide?.mcp;
    }

    roots(): string[] {
        return [...this.projects.keys()];
    }

    /** Finds the projects of the workspace again, starts the servers of new ones and stops those of removed ones. */
    async refresh(): Promise<void> {
        const exclude = '{**/node_modules/**,**/.*/**}';
        const [configs, models] = await Promise.all([workspace.findFiles('**/appling.config.json', exclude), workspace.findFiles('**/*.appling', exclude)]);
        const folders = (workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath);
        const roots = projectRoots(folders, configs.map(u => u.fsPath), models.map(u => u.fsPath));
        for (const [root, project] of this.projects) {
            if (roots.includes(root)) continue;
            project.ide?.close();
            this.projects.delete(root);
            this.panels.get(root)?.dispose();
        }
        for (const root of roots) {
            if (!this.projects.has(root)) this.projects.set(root, { root, modules: [] });
            this.projects.get(root)!.setUp = configs.some(config => dirname(config.fsPath) === root);
        }
        commands.executeCommand('setContext', 'appling.projects', this.projects.size);
        this.changed.fire();
        for (const project of this.projects.values()) if (!project.setUp) void this.suggestInit(project.root);
        if (this.initializing && this.projects.get(this.initializing)?.setUp) {
            void this.openIde(this.initializing);
            this.initializing = undefined;
        }
        this.updateMarks();
        // the servers start meanwhile; each one fills its project's modules in the view
        for (const root of roots) this.server(root).catch(() => undefined);
    }

    /** The project's IDE server, started on first use. */
    server(root: string): Promise<IdeProcess> {
        const project = this.projects.get(root);
        if (!project) return Promise.reject(new Error(`${root} is no Appling project.`));
        if (project.ide) return Promise.resolve(project.ide);
        project.starting ??= startIdeProcess(root, {
            node: process.execPath,
            // VS Code's own binary runs as Node, as for its language servers
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
            main: this.context.asAbsolutePath(join('out', 'ide', 'out', 'server', 'main.js')),
            sessions: this.store, playbooks: this.playbooks, host: this.host(),
            onStatus: status => {
                if (status.errors === undefined) return;
                project.errors = status.errors;
                void this.loadModules(project);
            },
            onImplementation: marks => {
                project.marks = marks;
                this.updateMarks();
            },
            onExit: (code, stderr) => {
                project.ide = undefined;
                project.starting = undefined;
                project.error = `The IDE server ended with code ${code}.`;
                console.error(stderr);
                this.changed.fire();
            }
        }).then(ide => {
            project.ide = ide;
            project.error = undefined;
            void this.loadModules(project);
            return ide;
        }, (error: Error) => {
            project.starting = undefined;
            project.error = error.message;
            this.changed.fire();
            throw error;
        });
        this.changed.fire();
        return project.starting;
    }

    /** Opens the project's IDE tab (a picked one when none is given), optionally with an element selected. */
    async openIde(root?: string, qn?: string): Promise<void> {
        root ??= await this.pickProject();
        if (root) await this.show(root, qn ? { type: 'element', qn } : undefined);
    }

    /** From a `.appling` editor into the IDE: the element at the cursor is selected there. */
    async openInIde(uri?: Uri): Promise<void> {
        const editor = window.activeTextEditor;
        const document = uri && editor?.document.uri.toString() !== uri.toString() ? await workspace.openTextDocument(uri) : editor?.document;
        if (!document) return this.openIde();
        const root = projectOf(this.roots(), document.uri.fsPath);
        if (!root) return void window.showInformationMessage(`${basename(document.uri.fsPath)} belongs to no Appling project of this workspace.`);
        const offset = editor?.document === document ? document.offsetAt(editor.selection.active) : 0;
        await this.show(root, { type: 'cursor', uri: document.uri.toString(), offset });
    }

    /** Shows the project's IDE tab, creating it with the server's client, and passes it the event. */
    private async show(root: string, event?: FrameEvent): Promise<void> {
        const existing = this.panels.get(root);
        if (existing) {
            existing.reveal();
            if (event) void existing.webview.postMessage(event);
            return;
        }
        const ide = await this.server(root).catch((error: Error) => {
            window.showErrorMessage(`The Appling IDE of ${basename(root)} did not start: ${error.message}`);
            return undefined;
        });
        if (!ide) return;
        const external = await env.asExternalUri(Uri.parse(ide.url));
        const origin = new URL(external.toString(true)).origin;
        // in a remote window the client reaches the server at a forwarded port
        if (origin !== new URL(ide.url).origin && ide.child.connected) ide.child.send({ type: 'trust', origin });
        const panel = window.createWebviewPanel('appling.ide', `Appling: ${basename(root)}`, ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
        panel.iconPath = Uri.file(this.context.asAbsolutePath(join('out', 'appling-icon.svg')));
        panel.webview.html = panelHtml(clientUrl(origin, this.workspaceId), randomBytes(16).toString('base64'));
        this.panels.set(root, panel);
        this.active = root;
        this.sidePanels.activate(root);
        panel.onDidChangeViewState(() => {
            if (!panel.active) return;
            this.active = root;
            this.sidePanels.activate(root);
        });
        panel.onDidDispose(() => {
            this.panels.delete(root);
            this.sidePanels.remove(root);
        });
        panel.webview.onDidReceiveMessage(message => void this.act(root, message));
        if (event) void panel.webview.postMessage(event);
    }

    /** Does what the IDE client asked for, after the checks of `panelAction`. */
    private async act(root: string, message: unknown): Promise<void> {
        const action = panelAction(root, message);
        if (!action) return;
        try {
            if (action.type === 'source') await revealOffsets(Uri.file(action.path), action.start, action.end, ViewColumn.Beside);
            else if (action.type === 'open') await openLines(action.path, action.start, action.end, ViewColumn.Beside);
            else if (action.type === 'diff') await openDiff(action.path, action.before, action.rev, action.line, ViewColumn.Beside);
            else if (action.type === 'focusSession') this.agents?.focus(action.session);
            else if (action.type === 'panels') this.sidePanels.update(root, action.state);
            else if (action.type === 'showPanel') this.sidePanels.show(action.name);
            else if (action.type === 'error') window.showErrorMessage(`Appling: ${action.message}`);
            else if (action.type === 'chooseStack') void this.sidePanels.chooseStack(root, action.selection);
            else if (action.type === 'edit') await this.sidePanels.apply(root, action.operation);
            else if (this.projects.has(action.repo)) await this.show(action.repo, { type: 'showChanges', ...action.session ? { session: action.session } : {} });
        } catch (error) {
            window.showErrorMessage(`Appling: ${(error as Error).message}`);
        }
    }

    /** A CodeLens on code shows its element in the IDE tab of the project that has it. */
    private showElement(qn: string): boolean {
        const project = this.list().find(p => Object.values(p.marks?.marks ?? {}).some(marks => marks.some(m => m.qn === qn)));
        if (!project) return false;
        void this.show(project.root, { type: 'element', qn });
        return true;
    }

    private updateMarks(): void {
        const state: ImplementationState = { marks: {}, links: {} };
        for (const project of this.projects.values()) {
            Object.assign(state.marks, project.marks?.marks);
            for (const [path, links] of Object.entries(project.marks?.links ?? {})) state.links[path] = [...state.links[path] ?? [], ...links];
        }
        this.implementation.update(state as ImplementationState);
    }

    private async loadModules(project: Project): Promise<void> {
        if (!project.ide) return;
        try {
            const snapshot = await (await fetch(`${project.ide.url}/api/snapshot`)).json() as { graph: { nodes: { qn: string, kind: string }[] }, errors: unknown[] };
            project.modules = snapshot.graph.nodes.filter(n => n.kind === 'Module').map(n => n.qn).sort();
            project.errors = snapshot.errors.length;
        } catch {
            // the server ended meanwhile; onExit reports it
        }
        this.changed.fire();
    }

    /** The IDE context VS Code adds for the sessions: the workspace, the project shown and the agent terminals. */
    private host(): AppHost {
        return {
            context: async () => ({ workspace: this.workspaceId, activeRepo: this.active, tabs: this.agents?.tabs() ?? [] }),
            act: async (session, action) => action.action === 'focus' ? this.agents?.focus(session.id) ?? false : false
        };
    }

    private async pickProject(): Promise<string | undefined> {
        const roots = this.roots();
        if (roots.length <= 1) return roots[0];
        const picked = await window.showQuickPick(roots.map(root => ({ label: basename(root), description: workspace.asRelativePath(root), root })), { placeHolder: 'The Appling project to open' });
        return picked?.root;
    }

    /**
     * Runs `appling init` (the CLI bundled with the extension, on VS Code's own Node) in a terminal in a workspace
     * folder: it asks for the project name, the coding agents and the stack, then writes the starter module,
     * `appling.config.json` and the agents' configuration and installs the packages. The IDE opens once the folder is
     * a project.
     */
    private async init(target?: string | Project): Promise<void> {
        let root = typeof target === 'string' ? target : target?.root;
        if (!root) {
            const folders = (workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file');
            if (!folders.length) return void window.showInformationMessage('Open a folder first; Appling initializes a project in it.');
            root = (folders.length === 1 ? folders[0] : await window.showWorkspaceFolderPick({ placeHolder: 'The folder to initialize Appling in' }))?.uri.fsPath;
            if (!root) return;
        }
        this.initializing = root;
        const terminal = window.createTerminal({
            name: 'Appling init', cwd: root, iconPath: Uri.file(this.context.asAbsolutePath(join('out', 'appling-icon.svg'))),
            shellPath: process.execPath, shellArgs: [this.context.asAbsolutePath(join('out', 'cli', 'main.js')), 'init', root],
            env: { ELECTRON_RUN_AS_NODE: '1' }
        });
        terminal.show();
    }

    private readonly suggested = new Set<string>();

    /** Once per session and project without `appling.config.json`, unless declined for good: offer `appling init`. */
    private async suggestInit(root: string): Promise<void> {
        if (this.suggested.has(root) || this.context.workspaceState.get<string[]>(DECLINED, []).includes(root)) return;
        this.suggested.add(root);
        const [initialize, never] = ['Initialize', 'Don\'t ask again'];
        const answer = await window.showInformationMessage(
            `Appling: ${basename(root)} is not set up yet. appling init connects your coding agents (.mcp.json and their rules), adds the .gitignore entries and picks the stack to generate with.`,
            initialize, never
        );
        if (answer === initialize) await this.init(root);
        if (answer === never) await this.context.workspaceState.update(DECLINED, [...this.context.workspaceState.get<string[]>(DECLINED, []), root]);
    }

    dispose(): void {
        for (const panel of this.panels.values()) panel.dispose();
        for (const project of this.projects.values()) project.ide?.close();
        this.disposables.forEach(d => d.dispose());
    }
}

/** The Projects view: each project with its modules; a click opens the IDE tab there. */
class ProjectsTree implements TreeDataProvider<Project | { project: Project, qn: string }> {
    readonly onDidChangeTreeData;

    constructor(private readonly workbench: Workbench) {
        this.onDidChangeTreeData = workbench.onDidChange;
    }

    getChildren(element?: Project | { project: Project, qn: string }) {
        if (!element) return this.workbench.list();
        return 'root' in element ? element.modules.map(qn => ({ project: element, qn })) : [];
    }

    getTreeItem(element: Project | { project: Project, qn: string }): TreeItem {
        if ('qn' in element) {
            const item = new TreeItem(element.qn, TreeItemCollapsibleState.None);
            item.iconPath = new ThemeIcon('symbol-namespace');
            item.command = { command: 'appling.openIde', title: 'Open in the Appling IDE', arguments: [element.project.root, element.qn] };
            item.contextValue = 'module';
            return item;
        }
        const item = new TreeItem(basename(element.root), TreeItemCollapsibleState.Expanded);
        item.id = element.root;
        item.tooltip = element.error ?? element.root;
        item.description = element.error ? 'not running' : !element.ide ? 'starting' : element.errors ? `${element.errors} error(s)` : !element.setUp ? 'not set up' : workspace.asRelativePath(element.root, false);
        item.iconPath = new ThemeIcon(element.error ? 'error' : 'project');
        item.command = { command: 'appling.openIde', title: 'Open in the Appling IDE', arguments: [element.root] };
        item.contextValue = element.setUp ? 'project' : 'project new';
        return item;
    }
}

/** The workspace the sessions and the playbook belong to: the `.code-workspace` file, else the first folder. */
function workspaceId(): string | undefined {
    const file = workspace.workspaceFile;
    if (file?.scheme === 'file') return file.fsPath;
    return workspace.workspaceFolders?.find(f => f.uri.scheme === 'file')?.uri.fsPath;
}

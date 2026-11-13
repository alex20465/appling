import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { agentPresets, geminiSystemSettingsFile, PRESETS_KEY, STATUS_LABELS, waiting, type AgentStatus, type Answer } from '@appling/ai/agents';
import { commands, ThemeColor, ThemeIcon, TreeItem, TreeItemCollapsibleState, window, workspace, type Disposable, type ExtensionContext, type TreeDataProvider } from 'vscode';
import { Agents, type AgentRecord } from './agents.js';
import { vscodeTerminals } from './agent-terminals.js';
import type { AgentHost, Workbench } from './workbench.js';

const ICONS: Record<AgentStatus, [string, string]> = {
    working: ['sync~spin', 'charts.green'], 'needs-input': ['bell-dot', 'charts.yellow'], blocked: ['bell-dot', 'charts.yellow'],
    done: ['check', 'descriptionForeground'], exited: ['circle-slash', 'descriptionForeground'], failed: ['error', 'charts.red']
};

/**
 * The agent sessions in VS Code (thin glue over `agents.ts`): the Agent Sessions view, the commands to start, show,
 * answer and end a session, and a notification when one waits for the user out of view. Presets are the built in
 * ones plus `appling.agents.presets`.
 */
export class AgentsView implements Disposable, AgentHost {
    readonly agents: Agents;
    private readonly disposables: Disposable[] = [];

    constructor(context: ExtensionContext, private readonly workbench: Workbench) {
        this.agents = new Agents({
            store: workbench.store,
            terminals: vscodeTerminals,
            folder: join(context.globalStorageUri.fsPath, 'agents'),
            ideMcp: repo => workbench.mcp(repo),
            hookScript: context.asAbsolutePath(join('out', 'hook.cjs')),
            workspace: workbench.workspaceId,
            geminiSystemSettings: () => {
                const file = geminiSystemSettingsFile();
                try {
                    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
                } catch {
                    return undefined;
                }
            }
        });
        const tree = new AgentsTree(this.agents);
        this.disposables.push(
            window.registerTreeDataProvider('appling.agents', tree),
            commands.registerCommand('appling.agents.new', (root?: string) => this.create(root)),
            commands.registerCommand('appling.agents.focus', (id?: string | AgentRecord) => this.agents.focus(typeof id === 'string' ? id : id?.id ?? '')),
            commands.registerCommand('appling.agents.answer', (id?: string | AgentRecord) => this.answer(typeof id === 'string' ? id : id?.id ?? '')),
            commands.registerCommand('appling.agents.end', (id?: string | AgentRecord) => this.agents.close(typeof id === 'string' ? id : id?.id ?? ''))
        );
        this.agents.on('waiting', record => void this.notify(record));
        workbench.attach(this);
    }

    start(): Promise<void> {
        return this.agents.start();
    }

    focus(session: string): boolean {
        return this.agents.focus(session);
    }

    tabs() {
        return this.agents.list().map(r => ({ id: r.id, title: this.agents.title(r), kind: 'agent', repo: r.repo, active: this.agents.visible(r.id) }));
    }

    private async create(root?: string): Promise<void> {
        root ??= await this.pickProject();
        if (!root) return;
        const { presets, problems } = agentPresets({ [PRESETS_KEY]: workspace.getConfiguration('appling').get('agents.presets') });
        if (problems.length) window.showWarningMessage(`Appling agent presets: ${problems.join('; ')}`);
        const preset = await window.showQuickPick(presets.map(p => ({ label: p.name, description: [p.command, ...p.args].join(' '), preset: p })), { placeHolder: `The agent to start in ${basename(root)}` });
        if (!preset) return;
        try {
            await this.workbench.server(root);
            await this.agents.create(root, preset.preset);
        } catch (error) {
            window.showErrorMessage(`The agent session did not start: ${(error as Error).message}`);
        }
    }

    private async pickProject(): Promise<string | undefined> {
        const roots = this.workbench.roots();
        if (!roots.length) return void window.showInformationMessage('There is no Appling project in this workspace; initialize one first.');
        if (roots.length === 1) return roots[0];
        const picked = await window.showQuickPick(roots.map(root => ({ label: basename(root), description: workspace.asRelativePath(root), root })), { placeHolder: 'The project the agent works in' });
        return picked?.root;
    }

    /** Asks the user for the answer to a waiting session's prompt, then writes it to its terminal. */
    private async answer(id: string): Promise<void> {
        const record = this.agents.get(id);
        if (!record || !waiting(record.status)) return;
        const answer = await this.ask(record);
        if (answer) this.agents.answer(id, answer);
    }

    private async ask(record: AgentRecord): Promise<Answer | undefined> {
        if (record.prompt?.kind === 'permission') {
            const choice = await window.showQuickPick(['Allow', 'Deny', 'Reply…'], { placeHolder: record.prompt.message });
            if (choice === 'Allow') return { kind: 'allow' };
            if (choice === 'Deny') return { kind: 'deny' };
            if (!choice) return undefined;
        }
        const text = await window.showInputBox({ prompt: record.prompt?.message ?? record.note ?? `${this.agents.title(record)} waits for your input`, placeHolder: 'Your reply' });
        return text ? { kind: 'reply', text } : undefined;
    }

    /** A session that waits while its terminal is out of view notifies, with its answers. */
    private async notify(record: AgentRecord): Promise<void> {
        if (this.agents.visible(record.id)) return;
        const message = `${this.agents.title(record)}: ${record.prompt?.message ?? record.note ?? 'waits for your input'}`;
        const actions = record.prompt?.kind === 'permission' ? ['Allow', 'Deny', 'Show'] : ['Reply…', 'Show'];
        const choice = await window.showInformationMessage(message, ...actions);
        if (choice === 'Allow') this.agents.answer(record.id, { kind: 'allow' });
        else if (choice === 'Deny') this.agents.answer(record.id, { kind: 'deny' });
        else if (choice === 'Reply…') await this.answer(record.id);
        else if (choice === 'Show') this.agents.focus(record.id);
    }

    dispose(): void {
        this.disposables.forEach(d => d.dispose());
        void this.agents.dispose();
    }
}

class AgentsTree implements TreeDataProvider<AgentRecord> {
    readonly onDidChangeTreeData: (listener: () => void) => Disposable;

    constructor(private readonly agents: Agents) {
        this.onDidChangeTreeData = listener => {
            agents.on('changed', listener);
            return { dispose: () => agents.off('changed', listener) };
        };
    }

    getChildren(): AgentRecord[] {
        return this.agents.list();
    }

    getTreeItem(record: AgentRecord): TreeItem {
        const item = new TreeItem(this.agents.title(record), TreeItemCollapsibleState.None);
        const [icon, color] = ICONS[record.status];
        item.id = record.id;
        item.iconPath = new ThemeIcon(icon, new ThemeColor(color));
        item.description = `${STATUS_LABELS[record.status]} · ${basename(record.repo)}`;
        item.tooltip = record.note ?? record.prompt?.message;
        item.contextValue = waiting(record.status) ? 'agent-waiting' : 'agent';
        item.command = { command: 'appling.agents.focus', title: 'Show the terminal', arguments: [record.id] };
        return item;
    }
}

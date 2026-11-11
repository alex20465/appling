import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, dialog, ipcMain, Menu, Notification, type BaseWindow, type MenuItemConstructorOptions, type WebContents } from 'electron';
import type { MemorySessionStore } from '@appling/ai';
import { stripJsonc } from '../code-workspace.js';
import type { TerminalPanel } from '../terminal/panel.js';
import { readSettingsFile } from '../terminal/settings.js';
import { boardEntries, sessionTitle, shouldNotify, type Attention, type BoardEntry } from './board.js';
import { agentPresets, geminiSystemSettingsFile, isAnswer, PRESETS_KEY, type AgentPreset, type Answer } from '@appling/ai/agents';
import { AgentSessions, type AgentRecord, type RemoteAgentHost } from './sessions.js';

export interface AgentUiOptions {
    userData: string;
    store: MemorySessionStore;
    panel: TerminalPanel;
    /** The MCP endpoint of the repo's IDE server. */
    ideMcp(repo: string): string | undefined;
    /** The machine of a connected remote repo, where its agents run. */
    remote?(repo: string): RemoteAgentHost | undefined;
    activeRepo(): string | undefined;
    /** The workspace a new session of the active repo belongs to. */
    activeWorkspace(): string | undefined;
    repoName(repo: string): string;
    workspaceName(id: string): string | undefined;
    /** What the user sees: whether the app has the focus, the shown repos and workspaces. */
    attention(): Omit<Attention, 'visible'>;
    /** Shows the repo in its workspace (and that workspace's window). */
    showRepo(repo: string, workspace?: string): void;
    /** The focused window's id, its shell page and whether it could be covered (the board, the answer form). */
    focusedWindow(): string;
    cover(window: string, on: boolean): boolean;
    send(window: string, channel: string, ...args: unknown[]): void;
    windowOf(sender: WebContents): string | undefined;
    /** Gives the focus back to the window's repo view. */
    focusActive(): void;
    /** Redraws every rail. */
    refresh(): void;
    window(): BaseWindow | undefined;
}

/**
 * The Electron side of agent sessions (#10): the New Agent Session menu, the session board and the answer form on
 * the shell page, desktop notifications for sessions that need input in the background, jumps from the board, the
 * rail, a notification or a claim on the canvas to the session's tab. Thin; the logic is in `sessions.ts`,
 * `board.ts`, `status.ts` and `presets.ts`.
 */
export class AgentUi {
    readonly sessions: AgentSessions;
    /** The window showing the board or the answer form, and which. */
    private overlay?: { window: string, kind: 'board' | 'answer', session?: string };
    private readonly notifications = new Map<string, Notification>();

    constructor(private readonly options: AgentUiOptions) {
        this.sessions = new AgentSessions({
            store: options.store,
            terminals: options.panel.service,
            folder: join(options.userData, 'agents'),
            ideMcp: options.ideMcp,
            remote: options.remote,
            presets: () => this.presets(),
            geminiSystemSettings: () => {
                const file = geminiSystemSettingsFile();
                if (!existsSync(file)) return undefined;
                try {
                    return JSON.parse(stripJsonc(readFileSync(file, 'utf8')) || '{}');
                } catch {
                    return undefined;
                }
            }
        });
        options.panel.agents = {
            tabs: repo => this.sessions.tabs(repo),
            menu: repo => this.menu(repo),
            rename: (terminal, name) => {
                const record = this.sessions.byTerminal(terminal);
                if (record) void this.sessions.rename(record.id, name);
                return !!record;
            }
        };
        this.sessions.on('changed', () => {
            options.panel.relayout();
            options.refresh();
            this.updateOverlay();
            for (const [id, notification] of this.notifications) {
                const record = this.sessions.get(id);
                if (!record || record.status !== 'needs-input') {
                    notification.close();
                    this.notifications.delete(id);
                }
            }
        });
        this.sessions.on('waiting', record => this.notify(record));
        this.handle();
    }

    async start(): Promise<void> {
        await this.sessions.start().catch(error => console.error(`Agent sessions did not start: ${(error as Error).message}`));
    }

    dispose(): void {
        this.sessions.dispose();
    }

    presets(): AgentPreset[] {
        const { presets, problems } = agentPresets(readSettingsFile(join(this.options.userData, 'settings.json')).settings);
        for (const problem of problems) console.error(`Appling Desktop settings: ${problem}`);
        return presets;
    }

    /** The New Agent Session menu: one entry per preset, then where custom presets go. */
    menu(repo: string): MenuItemConstructorOptions[] {
        return [
            ...this.presets().map((preset): MenuItemConstructorOptions => ({ label: preset.name, click: () => void this.create(repo, preset.name) })),
            { type: 'separator' },
            { label: `Add a Preset in settings.json ("${PRESETS_KEY}")…`, click: () => this.options.panel.actions().terminalSettings() }
        ];
    }

    async create(repo: string, preset: string): Promise<void> {
        try {
            const record = await this.sessions.create(repo, preset, { workspace: this.options.activeWorkspace() });
            void this.options.panel.reveal(record.repo, record.terminal);
        } catch (error) {
            dialog.showErrorBox('The agent session did not start', (error as Error).message);
        }
    }

    /** The menu commands. */
    actions(): Record<string, () => void> {
        return {
            newAgentSession: () => {
                const repo = this.options.activeRepo();
                const window = this.options.window();
                if (!repo || !window) return;
                Menu.buildFromTemplate(this.menu(repo)).popup({ window });
            },
            agentBoard: () => this.overlay?.kind === 'board' ? this.closeOverlay() : this.openOverlay('board')
        };
    }

    /** The repo's sessions for its rail button. */
    rail(repo: string) {
        return this.sessions.rail(repo);
    }

    /** The tabs of a session's workspace, for `ide_context`. */
    tabs(session: { workspace?: string, repo: string }) {
        return this.sessions.list()
            // a remote session's MCP session works in the repo's folder there
            .filter(r => session.workspace ? r.workspace === session.workspace : r.repo === session.repo || r.remote?.root === session.repo)
            .map(r => ({ id: r.id, title: sessionTitle(r), kind: 'agent', repo: r.repo, active: this.options.panel.showing(r.terminal) }));
    }

    /** Shows the session's tab: its repo in its workspace, the terminal panel open on it. */
    jump(id: string): boolean {
        const record = this.sessions.get(id);
        if (!record) return false;
        this.closeOverlay();
        this.options.showRepo(record.repo, record.workspace);
        void this.options.panel.reveal(record.repo, record.terminal);
        return true;
    }

    private entries(): BoardEntry[] {
        const repo = this.options.activeRepo();
        return boardEntries(this.sessions.list(), {
            repoName: this.options.repoName, workspaceName: this.options.workspaceName, active: repo ? this.sessions.active(repo)?.id : undefined
        });
    }

    private openOverlay(kind: 'board' | 'answer', session?: string): void {
        const window = this.options.focusedWindow();
        if (this.overlay && this.overlay.window !== window) this.closeOverlay();
        this.options.cover(window, true);
        this.overlay = { window, kind, session };
        this.options.refresh();
        this.updateOverlay();
    }

    private updateOverlay(): void {
        const overlay = this.overlay;
        if (!overlay) return;
        const entries = this.entries();
        if (overlay.kind === 'board') return this.options.send(overlay.window, 'agents:board', entries);
        const entry = entries.find(e => e.id === overlay.session);
        // the prompt was answered elsewhere (in the terminal, by a hook)
        if (!entry || !entry.prompt) return this.closeOverlay();
        this.options.send(overlay.window, 'agents:answer', entry);
    }

    private closeOverlay(): void {
        const overlay = this.overlay;
        if (!overlay) return;
        this.overlay = undefined;
        this.options.send(overlay.window, 'agents:close');
        if (this.options.cover(overlay.window, false)) {
            this.options.refresh();
            this.options.focusActive();
        }
    }

    private answer(id: string, answer: Answer): void {
        this.sessions.answer(id, answer);
        this.notifications.get(id)?.close();
        this.notifications.delete(id);
    }

    /**
     * A desktop notification for a session that needs input where the user does not look. On macOS it has Allow
     * and Deny buttons and a reply field; elsewhere a click shows the answer form over the rail.
     */
    private notify(record: AgentRecord): void {
        const attention = { ...this.options.attention(), visible: new Set(this.sessions.list().filter(r => this.options.panel.showing(r.terminal)).map(r => r.id)) };
        if (!shouldNotify(record, attention) || !Notification.isSupported()) return;
        const mac = process.platform === 'darwin';
        const permission = record.prompt?.kind === 'permission';
        const notification = new Notification({
            title: `${sessionTitle(record)} needs input`,
            body: `${this.options.repoName(record.repo)}: ${record.prompt?.message ?? record.note ?? 'Waiting for you'}`,
            ...mac ? {
                actions: permission ? [{ type: 'button' as const, text: 'Allow' }, { type: 'button' as const, text: 'Deny' }] : [],
                hasReply: true, replyPlaceholder: 'Reply to the agent'
            } : {}
        });
        notification.on('action', (_event, index) => this.answer(record.id, { kind: index === 0 ? 'allow' : 'deny' }));
        notification.on('reply', (_event, text) => this.answer(record.id, { kind: 'reply', text }));
        notification.on('click', () => {
            this.options.window()?.focus();
            app.focus({ steal: true });
            this.openOverlay('answer', record.id);
        });
        notification.on('close', () => this.notifications.get(record.id) === notification && this.notifications.delete(record.id));
        this.notifications.get(record.id)?.close();
        this.notifications.set(record.id, notification);
        notification.show();
    }

    private handle(): void {
        const window = (sender: WebContents) => this.options.windowOf(sender);
        ipcMain.on('agents:jump', (event, id) => window(event.sender) && typeof id === 'string' && this.jump(id));
        ipcMain.on('agents:board', event => window(event.sender) && this.openOverlay('board'));
        ipcMain.on('agents:openAnswer', (event, id) => window(event.sender) && typeof id === 'string' && this.openOverlay('answer', id));
        ipcMain.on('agents:close', event => window(event.sender) && this.closeOverlay());
        ipcMain.on('agents:answer', (event, id, answer) => {
            if (!window(event.sender) || typeof id !== 'string' || !isAnswer(answer)) return;
            this.answer(id, answer);
            this.closeOverlay();
        });
        ipcMain.on('agents:rename', (event, id, label) => window(event.sender) && typeof id === 'string' && typeof label === 'string' && void this.sessions.rename(id, label));
        ipcMain.on('agents:end', (event, id) => window(event.sender) && typeof id === 'string' && void this.sessions.close(id));
    }
}

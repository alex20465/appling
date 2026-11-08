import type { SessionStatus } from '@appling/ai';
import type { Notification } from '../terminal/shell-integration.js';
import type { Wiring } from './presets.js';

/**
 * The status of an agent session (#10). Label and status come from the agent itself through MCP (#16); what a
 * blocked agent cannot report, that it waits for input or finished its turn, comes from its hooks or its terminal
 * notifications (OSC 9, OSC 777), and its exit from the terminal. The output is never read. Pure.
 */
export type AgentStatus = SessionStatus | 'exited';

/** What the user is asked: a permission, a question, or a free reply. */
export interface AgentPrompt {
    kind: 'permission' | 'question' | 'input';
    message: string;
    /** ISO time. */
    at: string;
}

export interface StatusState {
    status: AgentStatus;
    note?: string;
    /** Set while the agent waits for the user. */
    prompt?: AgentPrompt;
}

export type Signal =
    /** The agent started a turn (a submitted prompt). */
    | { type: 'working' }
    /** The agent waits for the user: a permission, a question, a reply. */
    | { type: 'needs-input', kind: AgentPrompt['kind'], message: string }
    /** The agent finished its turn and waits for the next prompt. */
    | { type: 'idle', note?: string }
    | { type: 'failed', note?: string }
    /** The user answered or submitted something in the terminal. */
    | { type: 'answered' }
    | { type: 'exit', code: number, signal?: number };

/** The status colours of tabs, the rail and the board: green working, amber waiting, gray stopped or exited, red failed. */
export const STATUS_COLORS: Record<AgentStatus, string> = {
    working: '#5cbf63',
    'needs-input': '#e5a84f',
    blocked: '#e5a84f',
    done: '#8a8174',
    exited: '#8a8174',
    failed: '#e5684f'
};

export const STATUS_LABELS: Record<AgentStatus, string> = {
    working: 'Working',
    'needs-input': 'Needs input',
    blocked: 'Blocked',
    done: 'Done',
    exited: 'Exited',
    failed: 'Failed'
};

/** Whether the session waits for the user. */
export function waiting(status: AgentStatus): boolean {
    return status === 'needs-input' || status === 'blocked';
}

/** The state after a signal; an exited session stays exited. */
export function reduce(state: StatusState, signal: Signal, now: Date = new Date()): StatusState {
    if (state.status === 'exited') return state;
    switch (signal.type) {
        case 'exit':
            return { status: 'exited', note: `Exited with code ${signal.code}${signal.signal ? `, signal ${signal.signal}` : ''}` };
        case 'working':
            return { status: 'working' };
        case 'needs-input':
            return { status: 'needs-input', note: signal.message, prompt: { kind: signal.kind, message: signal.message, at: now.toISOString() } };
        case 'idle':
            // an agent still asking keeps asking: a turn ends only after its prompt was answered
            if (state.prompt && state.status === 'needs-input' && state.prompt.kind !== 'input') return state;
            return { status: 'done', ...signal.note ? { note: signal.note } : {} };
        case 'failed':
            return { status: 'failed', ...signal.note ? { note: signal.note } : {} };
        case 'answered':
            return waiting(state.status) || state.status === 'done' ? { status: 'working' } : state;
    }
}

/** Whether input typed into the terminal answers the agent: Enter, Escape alone or a digit while it asks. */
export function answers(state: StatusState, data: string): boolean {
    if (state.status === 'exited' || state.status === 'working') return false;
    if (data.includes('\r')) return true;
    return !!state.prompt && state.prompt.kind === 'permission' && (data === '\x1b' || /^[1-9yn]$/i.test(data));
}

/** The signal of a hook event posted to the gateway; undefined for events that say nothing about the status. */
export function hookSignal(wiring: Wiring, event: string, body: unknown): Signal | undefined {
    const input = body && typeof body === 'object' ? body as Record<string, unknown> : {};
    const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
    if (wiring === 'claude') {
        switch (event) {
            case 'UserPromptSubmit': return { type: 'working' };
            case 'PermissionRequest': return { type: 'needs-input', kind: 'permission', message: permissionText(input) };
            case 'Notification': {
                const type = input.notification_type;
                if (type === 'idle_prompt') return { type: 'idle' };
                if (type === 'permission_prompt') return { type: 'needs-input', kind: 'permission', message: text(input.message) ?? 'Permission needed' };
                if (type === 'elicitation_dialog' || type === 'elicitation_url_dialog' || type === 'agent_needs_input') {
                    return { type: 'needs-input', kind: 'question', message: text(input.message) ?? 'Waiting for your input' };
                }
                return undefined;
            }
            case 'Stop': return { type: 'idle', note: firstLine(text(input.last_assistant_message)) };
            case 'StopFailure': return { type: 'failed', note: firstLine(text(input.error) ?? text(input.message)) };
        }
        return undefined;
    }
    if (wiring === 'gemini') {
        switch (event) {
            case 'BeforeAgent': return { type: 'working' };
            case 'AfterAgent': return { type: 'idle', note: firstLine(text(input.prompt_response)) };
            case 'Notification':
                return input.notification_type === 'ToolPermission'
                    ? { type: 'needs-input', kind: 'permission', message: text(input.message) ?? 'Permission needed' }
                    : undefined;
        }
        return undefined;
    }
    if (wiring === 'opencode') {
        switch (event) {
            case 'permission.asked':
            case 'permission.updated':
                return { type: 'needs-input', kind: 'permission', message: text(input.title) ?? text(input.permission) ?? text(input.type) ?? 'Permission needed' };
            case 'permission.replied': return { type: 'working' };
            case 'session.idle': return { type: 'idle' };
            case 'session.error': {
                const error = input.error as Record<string, unknown> | undefined;
                return { type: 'failed', note: firstLine(text((error?.data as Record<string, unknown> | undefined)?.message) ?? text(error?.name)) };
            }
        }
    }
    return undefined;
}

/**
 * The signal of a terminal notification. Codex sends one for approvals and questions (fixed texts) and one with
 * the reply's preview when a turn finishes. Claude Code reports through its hooks, so its notifications are left
 * out. Every other agent's notification means it waits for the user.
 */
export function notificationSignal(wiring: Wiring, notification: Notification): Signal | undefined {
    const body = notification.body.trim();
    if (wiring === 'claude') return undefined;
    if (wiring === 'codex') {
        if (/^(Approval requested|Codex wants to edit)/.test(body)) return { type: 'needs-input', kind: 'permission', message: body };
        if (/^(Plan mode prompt|Question):/.test(body)) return { type: 'needs-input', kind: 'question', message: body };
        return { type: 'idle', note: firstLine(body) };
    }
    return { type: 'needs-input', kind: 'input', message: [notification.title, body].filter(Boolean).join(': ') || 'Waiting for your input' };
}

/** What Claude Code asks permission for: the tool and its command, file or description. */
function permissionText(input: Record<string, unknown>): string {
    const tool = typeof input.tool_name === 'string' ? input.tool_name : 'a tool';
    const args = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input as Record<string, unknown> : {};
    const detail = [args.command, args.file_path, args.url, args.description].find(v => typeof v === 'string' && v.trim()) as string | undefined;
    return `Allow ${tool}${detail ? `: ${firstLine(detail)}` : ''}?`;
}

function firstLine(text: string | undefined, max = 160): string | undefined {
    if (!text) return undefined;
    const line = text.split('\n').find(l => l.trim())?.trim() ?? '';
    return line.length > max ? `${line.slice(0, max - 1)}…` : line || undefined;
}

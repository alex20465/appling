import { join as nativeJoin, posix } from 'node:path';

/**
 * Agent presets (#10): which program an agent session runs and how it reaches the repo's Appling MCP server with
 * no manual setup. Every agent gets the MCP server through its own CLI flags, environment or a configuration file
 * the app (Appling Desktop, the VS Code extension) writes into the session's own folder, never through the user's configuration files. Pure: `launch`
 * returns the command, arguments, environment and files, which `AgentSessions` writes and starts in a terminal.
 */

/**
 * How a preset hands the agent the MCP server and hears its status:
 * - `claude`: Claude Code's `--mcp-config` (an HTTP server with an Authorization header) and `--settings` with HTTP
 *   hooks (PermissionRequest, Notification, Stop, StopFailure, UserPromptSubmit) to the session gateway.
 * - `codex`: Codex's `-c mcp_servers.appling.*` overrides (the bearer token from an environment variable) and its TUI
 *   notifications as OSC 9, always, for approvals and finished turns.
 * - `gemini`: a system settings file of the session's own (`GEMINI_CLI_SYSTEM_SETTINGS_PATH`, merged over the
 *   machine's) with the MCP server and command hooks (BeforeAgent, AfterAgent, Notification).
 * - `opencode`: `OPENCODE_CONFIG_CONTENT` with a remote MCP server and a plugin in `OPENCODE_CONFIG_DIR` that posts
 *   permission and idle events to the gateway.
 * - `env`: only the environment (`APPLING_MCP_URL`, `APPLING_MCP_TOKEN`, `APPLING_HOOK_URL`) and the `{mcpUrl}`,
 *   `{token}` and `{hookUrl}` placeholders in the arguments; status from OSC 9 and OSC 777 notifications.
 */
export type Wiring = 'claude' | 'codex' | 'gemini' | 'opencode' | 'env';
export const WIRINGS: readonly Wiring[] = ['claude', 'codex', 'gemini', 'opencode', 'env'];

/** The keys an answer writes to the agent's terminal. `option` holds `{n}` for the option's number. */
export interface AnswerKeys {
    allow: string;
    deny: string;
    option: string;
    /** Ends a typed reply. */
    submit: string;
}

export interface AgentPreset {
    /** The name in menus and the tab's first label, such as `Claude Code`. */
    name: string;
    command: string;
    args: string[];
    env: Record<string, string>;
    wiring: Wiring;
    answers: AnswerKeys;
    /** From the app rather than the user's settings. */
    builtin: boolean;
}

const KEYS: AnswerKeys = { allow: '\r', deny: '\x1b', option: '{n}', submit: '\r' };

export const BUILTIN_PRESETS: readonly AgentPreset[] = [
    { name: 'Claude Code', command: 'claude', args: [], env: {}, wiring: 'claude', answers: KEYS, builtin: true },
    // Codex's approval overlay takes y for yes and Escape for no
    { name: 'Codex', command: 'codex', args: [], env: {}, wiring: 'codex', answers: { ...KEYS, allow: 'y' }, builtin: true },
    { name: 'Gemini CLI', command: 'gemini', args: [], env: {}, wiring: 'gemini', answers: KEYS, builtin: true },
    { name: 'opencode', command: 'opencode', args: [], env: {}, wiring: 'opencode', answers: KEYS, builtin: true }
];

/** The key of the custom presets in the app's settings (Desktop's `settings.json`, VS Code's `appling.agents.presets`). */
export const PRESETS_KEY = 'agents.presets';

/**
 * The presets: the built in ones, then the custom ones of `agents.presets` in `settings.json`; a custom preset with
 * a built in one's name replaces it. A custom preset needs `name` and `command`; `args`, `env`, `wiring` (default
 * `env`) and `answers` are optional.
 */
export function agentPresets(settings: Record<string, unknown>): { presets: AgentPreset[], problems: string[] } {
    const presets = [...BUILTIN_PRESETS];
    const problems: string[] = [];
    const custom = settings[PRESETS_KEY];
    if (custom === undefined) return { presets, problems };
    if (!Array.isArray(custom)) return { presets, problems: [`"${PRESETS_KEY}" must be a list of presets`] };
    custom.forEach((entry, index) => {
        const where = `"${PRESETS_KEY}"[${index}]`;
        if (!entry || typeof entry !== 'object') return problems.push(`${where} must be an object`);
        const { name, command, args = [], env = {}, wiring = 'env', answers = {} } = entry as Record<string, unknown>;
        if (typeof name !== 'string' || !name.trim()) return problems.push(`${where} needs a "name"`);
        if (typeof command !== 'string' || !command.trim()) return problems.push(`${where} needs a "command"`);
        if (!Array.isArray(args) || args.some(a => typeof a !== 'string')) return problems.push(`${where}: "args" must be a list of strings`);
        if (!env || typeof env !== 'object' || Object.values(env).some(v => typeof v !== 'string')) return problems.push(`${where}: "env" must map names to strings`);
        if (!WIRINGS.includes(wiring as Wiring)) return problems.push(`${where}: "wiring" must be one of ${WIRINGS.join(', ')}`);
        const base = BUILTIN_PRESETS.find(p => p.wiring === wiring)?.answers ?? KEYS;
        const keys = Object.fromEntries(Object.entries(answers as object).filter(([key, value]) => key in KEYS && typeof value === 'string'));
        const preset: AgentPreset = { name: name.trim(), command, args: args as string[], env: env as Record<string, string>, wiring: wiring as Wiring, answers: { ...base, ...keys }, builtin: false };
        const known = presets.findIndex(p => p.name === preset.name);
        if (known >= 0) presets[known] = preset;
        else presets.push(preset);
    });
    return { presets, problems };
}

/** Gemini CLI's own system settings file, merged under a session's; see its configuration reference. */
export function geminiSystemSettingsFile(): string {
    if (process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH) return process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
    if (process.platform === 'darwin') return '/Library/Application Support/GeminiCli/settings.json';
    if (process.platform === 'win32') return 'C:\\ProgramData\\gemini-cli\\settings.json';
    return '/etc/gemini-cli/settings.json';
}

/** What a session's launch needs to know. */
export interface LaunchContext {
    /** The session id, also in `APPLING_SESSION`. */
    session: string;
    /** The gateway's MCP endpoint, which forwards to the repo's IDE server. */
    mcpUrl: string;
    /** The gateway's hook endpoint; an event goes to `<hookUrl>/<event>`. */
    hookUrl: string;
    /** The session's bearer token. */
    token: string;
    /** The session's own folder (mode 0700), for its configuration files. */
    dir: string;
    /** The hook client script for command hooks (`hook.cjs`), run with `node`. */
    hookScript: string;
    /** For Gemini CLI: the machine's system settings, merged under the session's. */
    geminiSystemSettings?: Record<string, unknown>;
    /**
     * The agent runs on another machine (a remote repo): paths and hook command lines are POSIX ones there, whatever
     * this machine is.
     */
    posix?: boolean;
    /** The Node binary that runs the hook script; `node` from the PATH by default. */
    node?: string;
}

export interface Launch {
    command: string;
    args: string[];
    env: Record<string, string>;
    /** Files to write (mode 0600) before the start, by absolute path. */
    files: Record<string, string>;
}

/** The MCP server's name in the agent's configuration. */
export const SERVER = 'appling';

/** The hook events each wiring sends to the gateway. */
export const CLAUDE_HOOKS = ['PermissionRequest', 'Notification', 'Stop', 'StopFailure', 'UserPromptSubmit'] as const;
export const GEMINI_HOOKS = ['BeforeAgent', 'AfterAgent', 'Notification'] as const;
export const OPENCODE_EVENTS = ['permission.asked', 'permission.updated', 'permission.replied', 'session.idle', 'session.error'] as const;

/** The command, arguments, environment and files that start a preset's agent wired to the session's MCP server. */
export function launch(preset: AgentPreset, context: LaunchContext): Launch {
    const env: Record<string, string> = {
        ...preset.env,
        APPLING_SESSION: context.session,
        APPLING_MCP_URL: context.mcpUrl,
        APPLING_MCP_TOKEN: context.token,
        APPLING_HOOK_URL: context.hookUrl
    };
    const fill = (arg: string) => arg.replaceAll('{mcpUrl}', context.mcpUrl).replaceAll('{token}', context.token).replaceAll('{hookUrl}', context.hookUrl);
    const args = preset.args.map(fill);
    const files: Record<string, string> = {};
    const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
    const authorization = `Bearer ${context.token}`;
    const join = context.posix ? posix.join : nativeJoin;
    const quote = (value: string) => shellWord(value, context.posix ? 'posix' : process.platform === 'win32' ? 'cmd' : 'posix');
    switch (preset.wiring) {
        case 'claude': {
            const mcp = join(context.dir, 'mcp.json');
            const settings = join(context.dir, 'settings.json');
            files[mcp] = json({ mcpServers: { [SERVER]: { type: 'http', url: context.mcpUrl, headers: { Authorization: authorization } } } });
            files[settings] = json({
                hooks: Object.fromEntries(CLAUDE_HOOKS.map(event => [event, [{
                    hooks: [{ type: 'http', url: `${context.hookUrl}/${event}`, timeout: 5, headers: { Authorization: authorization } }]
                }]]))
            });
            args.push('--mcp-config', mcp, '--settings', settings);
            break;
        }
        case 'codex':
            args.push(
                '-c', `mcp_servers.${SERVER}.url=${JSON.stringify(context.mcpUrl)}`,
                '-c', `mcp_servers.${SERVER}.bearer_token_env_var="APPLING_MCP_TOKEN"`,
                // approvals, questions and finished turns arrive as OSC 9, also while the terminal has the focus
                '-c', 'tui.notifications=true',
                '-c', 'tui.notification_method="osc9"',
                '-c', 'tui.notification_condition="always"'
            );
            break;
        case 'gemini': {
            const settings = join(context.dir, 'gemini-settings.json');
            const token = join(context.dir, 'token');
            files[token] = context.token;
            const base = context.geminiSystemSettings ?? {};
            const hook = (event: string) => ({ hooks: [{ name: `appling-${event}`, type: 'command', command: `${quote(context.node ?? 'node')} ${quote(context.hookScript)} ${quote(`${context.hookUrl}/${event}`)} ${quote(token)}`, timeout: 5000 }] });
            const hooks = { ...(base.hooks as Record<string, unknown[]> | undefined) ?? {} };
            for (const event of GEMINI_HOOKS) hooks[event] = [...hooks[event] ?? [], hook(event)];
            files[settings] = json({
                ...base,
                mcpServers: { ...(base.mcpServers as object | undefined) ?? {}, [SERVER]: { httpUrl: context.mcpUrl, headers: { Authorization: authorization } } },
                hooksConfig: { ...(base.hooksConfig as object | undefined) ?? {}, enabled: true },
                hooks
            });
            env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = settings;
            break;
        }
        case 'opencode': {
            const dir = join(context.dir, 'opencode');
            // older versions read `plugin/`, newer ones `plugins/`
            for (const folder of ['plugin', 'plugins']) files[join(dir, folder, 'appling-status.js')] = OPENCODE_PLUGIN;
            env.OPENCODE_CONFIG_DIR = dir;
            env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ mcp: { [SERVER]: { type: 'remote', url: context.mcpUrl, headers: { Authorization: authorization }, oauth: false } } });
            break;
        }
        case 'env':
            break;
    }
    return { command: preset.command, args, env, files };
}

/** The opencode plugin that reports permission requests and idle sessions to the gateway. */
export const OPENCODE_PLUGIN = `// Written by Appling for one agent session: reports permission requests and idle sessions.
const EVENTS = new Set(${JSON.stringify(OPENCODE_EVENTS)});
export const ApplingStatus = async () => ({
    event: async ({ event }) => {
        if (!EVENTS.has(event.type) || !process.env.APPLING_HOOK_URL) return;
        await fetch(\`\${process.env.APPLING_HOOK_URL}/\${event.type}\`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: \`Bearer \${process.env.APPLING_MCP_TOKEN}\` },
            body: JSON.stringify(event.properties ?? {})
        }).catch(() => undefined);
    }
});
`;

/** A shell word for a hook command line (POSIX shells, and cmd for paths without quotes). */
function shellWord(value: string, shell: 'posix' | 'cmd'): string {
    return /^[\w./:@%+=,-]+$/.test(value) ? value : shell === 'cmd' ? `"${value}"` : `'${value.replaceAll("'", `'\\''`)}'`;
}

/** What the user answers a waiting agent. */
export type Answer = { kind: 'allow' } | { kind: 'deny' } | { kind: 'option', option: number } | { kind: 'reply', text: string };

/** The keys that answer a prompt of the preset's agent, written to its terminal. A reply is one line. */
export function answerKeys(keys: AnswerKeys, answer: Answer): string {
    switch (answer.kind) {
        case 'allow': return keys.allow;
        case 'deny': return keys.deny;
        case 'option': return keys.option.replaceAll('{n}', String(answer.option));
        case 'reply': return `${answer.text.replace(/[\r\n]+/g, ' ').trim()}${keys.submit}`;
    }
}

/** Whether an answer from the outside is well formed (it comes over IPC). */
export function isAnswer(value: unknown): value is Answer {
    const answer = value as Answer;
    if (!answer || typeof answer !== 'object') return false;
    if (answer.kind === 'allow' || answer.kind === 'deny') return true;
    if (answer.kind === 'option') return Number.isInteger(answer.option) && answer.option >= 1 && answer.option <= 9;
    return answer.kind === 'reply' && typeof answer.text === 'string' && answer.text.length <= 10000;
}

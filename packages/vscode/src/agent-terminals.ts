import { NotificationScanner } from '@appling/pty-host/status';
import { Disposable, ThemeIcon, window, type TerminalShellExecution } from 'vscode';
import type { AgentTerminal, AgentTerminals } from './agents.js';

/** How long a new terminal may take to report its shell integration before the agent starts without it. */
const INTEGRATION_TIMEOUT = 4000;

/**
 * Agents in VS Code's integrated terminals. The agent runs as a command of the user's shell through its shell
 * integration, whose output stream carries the agent's notifications (OSC 9, OSC 777) and whose end carries the exit
 * code. Without shell integration the command is typed into the shell instead; the status then comes from the agent's
 * hooks and MCP alone. VS Code shows extensions no terminal input, so a prompt answered by typing into the terminal
 * clears with the agent's next report.
 */
export const vscodeTerminals: AgentTerminals = (spec, events) => {
    const terminal = window.createTerminal({ name: spec.name, cwd: spec.cwd, env: spec.env, iconPath: new ThemeIcon('hubot'), isTransient: true });
    const subscriptions: Disposable[] = [];
    let execution: TerminalShellExecution | undefined;
    subscriptions.push(
        // the agent's end leaves the terminal with its output; closing it ends the session
        window.onDidEndTerminalShellExecution(event => {
            if (event.execution === execution) events.exit(event.exitCode ?? 0);
        }),
        window.onDidCloseTerminal(closed => {
            if (closed !== terminal) return;
            Disposable.from(...subscriptions).dispose();
            events.exit(undefined);
        })
    );
    const run = (integrated: boolean) => {
        if (!integrated || !terminal.shellIntegration) {
            terminal.sendText([spec.command, ...spec.args].map(shellWord).join(' '));
            return;
        }
        execution = terminal.shellIntegration.executeCommand(spec.command, spec.args);
        const scanner = new NotificationScanner();
        void (async () => {
            for await (const data of execution.read()) for (const notification of scanner.feed(data)) events.notification(notification);
        })().catch(() => undefined);
    };
    if (terminal.shellIntegration) run(true);
    else {
        const timer = setTimeout(() => { waiting.dispose(); run(false); }, INTEGRATION_TIMEOUT);
        const waiting = window.onDidChangeTerminalShellIntegration(event => {
            if (event.terminal !== terminal) return;
            clearTimeout(timer);
            waiting.dispose();
            run(true);
        });
        subscriptions.push(waiting);
    }
    terminal.show();
    const handle: AgentTerminal = {
        write: data => terminal.sendText(data, false),
        show: () => terminal.show(),
        visible: () => window.state.focused && window.activeTerminal === terminal,
        dispose: () => terminal.dispose()
    };
    return handle;
};

/** A word for the user's shell, quoted unless plain. */
function shellWord(value: string): string {
    if (/^[\w./:@%+=,-]+$/.test(value)) return value;
    return process.platform === 'win32' ? `"${value.replaceAll('"', '\\"')}"` : `'${value.replaceAll("'", `'\\''`)}'`;
}

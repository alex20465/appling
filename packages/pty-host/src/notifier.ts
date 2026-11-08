import { execFile, spawn } from 'node:child_process';
import type { TerminalNotification } from './status.js';

/** What the host shows when a terminal needs input and no app is attached. */
export interface NotifyRequest {
    /** The terminal's id, for the open command. */
    terminal: string;
    title: string;
    body: string;
    /** Whether the notification may offer a reply field (programs that read a line; not for raw TUI input). */
    reply: boolean;
}

/** What the user did with it: opened the app at the session, answered in it, or nothing (dismissed, timed out). */
export type NotifyAnswer = { action: 'open' } | { action: 'reply', text: string } | undefined;

/** Raises desktop notifications. The host injects one; tests pass a fake, a remote host none. */
export interface Notifier {
    notify(request: NotifyRequest): Promise<NotifyAnswer>;
}

/** The title and body of a terminal's notification: its own title, else the session's label, title or group. */
export function notificationText(notification: TerminalNotification, terminal: { title?: string, group?: string, meta?: Record<string, string> }): { title: string, body: string } {
    const label = terminal.meta?.label ?? terminal.title;
    const where = terminal.group ? terminal.group.split(/[\\/]/).filter(Boolean).pop() : undefined;
    const title = notification.title || [label, where].filter(Boolean).join(' · ') || 'Appling';
    return { title, body: notification.body || 'Needs your input' };
}

export interface Run {
    code: number | null;
    stdout: string;
    stderr: string;
    /** Set when the program could not be started (`ENOENT` when it is not installed). */
    error?: string;
}

/** Runs a program to its end; the system notifier's only access to the system, so tests can replace it. */
export type Runner = (command: string, args: string[], options: { timeout: number }) => Promise<Run>;

export const runProgram: Runner = (command, args, { timeout }) => new Promise(resolve => {
    execFile(command, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        const code = error ? typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null : 0;
        const failed = error && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : undefined;
        resolve({ code, stdout: String(stdout), stderr: String(stderr), ...failed ? { error: failed } : {} });
    });
});

/** How long a notification waits for an answer before the host stops listening. */
const WAIT = 30 * 60 * 1000;

export interface SystemNotifierOptions {
    platform?: NodeJS.Platform;
    run?: Runner;
    /** Milliseconds to wait for an answer, 30 minutes by default. */
    wait?: number;
}

/**
 * The notifier of the operating system:
 * - Linux: `gdbus` over `org.freedesktop.Notifications` when the notification server offers `inline-reply` (KDE
 *   Plasma, among others), with Open and a reply field; else `notify-send` with an Open action (libnotify 0.7.9+;
 *   older ones show the notification without it).
 * - macOS: `osascript` with a dialog that has Open and a reply field (a plain AppleScript notification can not be
 *   clicked through to an app).
 * - Windows: a PowerShell toast with a reply field and Open.
 */
export function systemNotifier(options: SystemNotifierOptions = {}): Notifier {
    const platform = options.platform ?? process.platform;
    const run = options.run ?? runProgram;
    const wait = options.wait ?? WAIT;
    return {
        async notify(request) {
            if (platform === 'darwin') {
                const result = await run('osascript', osascriptArgs(request, Math.round(wait / 1000)), { timeout: wait + 5000 });
                return parseOsascript(result.stdout);
            }
            if (platform === 'win32') {
                const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(toastScript(request, Math.round(wait / 1000)))], { timeout: wait + 10000 });
                return parseToast(result.stdout);
            }
            return linuxNotify(request, run, wait);
        }
    };
}

async function linuxNotify(request: NotifyRequest, run: Runner, wait: number): Promise<NotifyAnswer> {
    const caps = await run('gdbus', [...GDBUS_TARGET, '--method', 'org.freedesktop.Notifications.GetCapabilities'], { timeout: 3000 });
    const capabilities = caps.code === 0 ? parseCapabilities(caps.stdout) : undefined;
    if (capabilities?.includes('inline-reply') && request.reply) return gdbusNotify(request, wait);
    const withActions = !capabilities || capabilities.includes('actions');
    let result = await run('notify-send', notifySendArgs(request, withActions), { timeout: wait + 5000 });
    // libnotify before 0.7.9 has no --action
    if (result.code !== 0 && withActions && /action|unknown option/i.test(result.stderr)) result = await run('notify-send', notifySendArgs(request, false), { timeout: 10000 });
    if (result.error === 'ENOENT' && capabilities) return gdbusNotify({ ...request, reply: false }, wait);
    return parseNotifySend(result.stdout);
}

/** `notify-send` with an Open action as the default (a click on the body) and as a button; it prints the chosen one. */
export function notifySendArgs(request: NotifyRequest, actions: boolean): string[] {
    return ['--app-name=Appling', '--urgency=normal', ...actions ? ['--action=default=Open', '--action=open=Open'] : [], '--', request.title, request.body];
}

export function parseNotifySend(stdout: string): NotifyAnswer {
    const action = stdout.trim().split('\n').pop();
    return action === 'open' || action === 'default' ? { action: 'open' } : undefined;
}

const GDBUS_TARGET = ['call', '--session', '--dest', 'org.freedesktop.Notifications', '--object-path', '/org/freedesktop/Notifications'];

/** The strings of `GetCapabilities`' answer, `(['actions', 'body', 'inline-reply'],)`. */
export function parseCapabilities(stdout: string): string[] {
    return [...stdout.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map(m => m[1]);
}

/** A GVariant text format string. */
export function gvariantString(text: string): string {
    return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/[\x00-\x1f]/g, ' ')}'`;
}

/** The arguments of `gdbus call ... Notify`: default and Open actions and, with `reply`, the inline reply action. */
export function gdbusNotifyArgs(request: NotifyRequest): string[] {
    const actions = ['default', 'Open', 'open', 'Open', ...request.reply ? ['inline-reply', 'Reply'] : []];
    return [...GDBUS_TARGET, '--method', 'org.freedesktop.Notifications.Notify',
        gvariantString('Appling'), 'uint32 0', gvariantString(''), gvariantString(request.title), gvariantString(request.body),
        `[${actions.map(gvariantString).join(', ')}]`, '@a{sv} {}', 'int32 0'];
}

/** A signal of `gdbus monitor` for the notification: an action, a reply or its closing. */
export function parseMonitorLine(line: string, id: number): NotifyAnswer | 'closed' | undefined {
    const match = /\.(ActionInvoked|NotificationReplied|NotificationClosed) \(uint32 (\d+), (.*)\)\s*$/.exec(line);
    if (!match || Number(match[2]) !== id) return undefined;
    if (match[1] === 'NotificationClosed') return 'closed';
    const value = parseCapabilities(match[3])[0]?.replace(/\\(.)/g, '$1') ?? '';
    if (match[1] === 'NotificationReplied') return { action: 'reply', text: value };
    return value === 'default' || value === 'open' ? { action: 'open' } : undefined;
}

/** Notify over D-Bus and follow the server's signals with `gdbus monitor` until an answer, the close or the timeout. */
function gdbusNotify(request: NotifyRequest, wait: number): Promise<NotifyAnswer> {
    return new Promise(resolve => {
        const monitor = spawn('gdbus', ['monitor', '--session', '--dest', 'org.freedesktop.Notifications', '--object-path', '/org/freedesktop/Notifications'], { stdio: ['ignore', 'pipe', 'ignore'] });
        let id: number | undefined;
        const early: string[] = [];
        let buffer = '';
        const done = (answer: NotifyAnswer) => {
            clearTimeout(timer);
            monitor.kill();
            resolve(answer);
        };
        const timer = setTimeout(() => done(undefined), wait);
        const handle = (line: string) => {
            if (id === undefined) return void early.push(line);
            const answer = parseMonitorLine(line, id);
            if (answer === 'closed') done(undefined);
            else if (answer) done(answer);
        };
        monitor.on('error', () => done(undefined));
        monitor.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
            buffer += chunk;
            const lines = buffer.split('\n');
            buffer = lines.pop()!;
            lines.forEach(handle);
        });
        // the monitor subscribes first, so not even a quick answer is missed
        setTimeout(() => {
            execFile('gdbus', gdbusNotifyArgs(request), { timeout: 5000 }, (error, stdout) => {
                const match = /uint32 (\d+)/.exec(String(stdout));
                if (error || !match) return done(undefined);
                id = Number(match[1]);
                early.splice(0).forEach(handle);
            });
        }, 200);
    });
}

/** `osascript` running a dialog; the texts go as arguments, so nothing needs quoting. */
export function osascriptArgs(request: NotifyRequest, seconds: number): string[] {
    const answer = request.reply ? ' default answer ""' : '';
    const buttons = request.reply ? '{"Ignore", "Open", "Reply"}' : '{"Ignore", "Open"}';
    return ['-e', 'on run argv',
        '-e', `display dialog (item 2 of argv) with title (item 1 of argv)${answer} buttons ${buttons} default button "Open" giving up after ${seconds}`,
        '-e', 'end run', request.title, request.body];
}

/** `button returned:Reply, text returned:yes, gave up:false` */
export function parseOsascript(stdout: string): NotifyAnswer {
    const button = /button returned:([^,\n]*)/.exec(stdout)?.[1];
    if (/gave up:true/.test(stdout)) return undefined;
    if (button === 'Open') return { action: 'open' };
    if (button === 'Reply') return { action: 'reply', text: /text returned:(.*?)(?:, gave up:|$)/s.exec(stdout)?.[1]?.replace(/\n$/, '') ?? '' };
    return undefined;
}

function xml(text: string): string {
    return text.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
}

/** PowerShell's own app id, which may show toasts without an installed app. */
const POWERSHELL_APP = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

/** A toast with Open (also a click on it) and a reply field; prints the answer as JSON. */
export function toastScript(request: NotifyRequest, seconds: number): string {
    const toast = `<toast activationType="foreground" launch="open"><visual><binding template="ToastGeneric"><text>${xml(request.title)}</text><text>${xml(request.body)}</text></binding></visual><actions>`
        + (request.reply ? '<input id="reply" type="text" placeHolderContent="Reply"/><action content="Send" arguments="reply" hint-inputId="reply" activationType="foreground"/>' : '')
        + '<action content="Open" arguments="open" activationType="foreground"/></actions></toast>';
    const quote = (text: string) => `'${text.replace(/'/g, "''")}'`;
    return [
        '$ErrorActionPreference = "Stop"',
        '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
        '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
        '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
        `$xml.LoadXml(${quote(toast)})`,
        '$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)',
        'Register-ObjectEvent -InputObject $toast -EventName Activated -SourceIdentifier activated | Out-Null',
        'Register-ObjectEvent -InputObject $toast -EventName Dismissed -SourceIdentifier dismissed | Out-Null',
        `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${quote(POWERSHELL_APP)}).Show($toast)`,
        `$event = Wait-Event -Timeout ${seconds}`,
        'if ($event -and $event.SourceIdentifier -eq "activated") {',
        '  $activated = $event.SourceArgs[1]',
        '  $text = $null',
        '  try { $text = $activated.UserInput["reply"] } catch {}',
        '  ConvertTo-Json -Compress @{ action = $activated.Arguments; text = $text }',
        '}'
    ].join('\n');
}

export function encodePowerShell(script: string): string {
    return Buffer.from(script, 'utf16le').toString('base64');
}

export function parseToast(stdout: string): NotifyAnswer {
    try {
        const answer = JSON.parse(stdout.trim()) as { action?: string, text?: string | null };
        if (answer.action === 'reply' && typeof answer.text === 'string') return { action: 'reply', text: answer.text };
        if (answer.action === 'open' || answer.action === 'reply') return { action: 'open' };
    } catch {
        // dismissed or timed out: nothing printed
    }
    return undefined;
}

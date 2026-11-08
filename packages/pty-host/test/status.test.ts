import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, test } from 'vitest';
import { connectPtyHost, hostMain, PtyHostClient, type NotifyAnswer, type NotifyRequest, type TerminalStatus } from '../src/index.js';
import { PtyHost } from '../src/host.js';
import {
    gdbusNotifyArgs, gvariantString, notificationText, notifySendArgs, osascriptArgs, parseCapabilities, parseMonitorLine,
    parseNotifySend, parseOsascript, parseToast, systemNotifier, toastScript, type Runner
} from '../src/notifier.js';
import { socketPath } from '../src/paths.js';
import { answers } from '../src/protocol.js';
import { NotificationScanner, StatusTracker } from '../src/status.js';

const run = promisify(execFile);
const SH = { shell: '/bin/sh', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', PS1: '$ ', HOME: tmpdir() } };
/** Notifies with OSC 9, reads the answer, prints it and exits with 5. */
const ASKS = ['-c', 'printf "\\033]9;Approve the plan?\\007"; read answer; echo "got-$answer"; exit 5'];
const dirs: string[] = [];
const hosts: PtyHost[] = [];

function hostDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'pty-'));
    dirs.push(dir);
    return dir;
}

afterAll(async () => {
    for (const host of hosts) await host.close();
    for (const dir of dirs) {
        const client = await PtyHostClient.connect(dir).catch(() => undefined);
        await client?.shutdown().catch(() => undefined);
        await until(async () => !await answers(socketPath(dir)));
        rmSync(dir, { recursive: true, force: true });
    }
});

async function until(check: () => boolean | Promise<boolean>, timeout = 5000): Promise<void> {
    const deadline = Date.now() + timeout;
    while (!await check()) {
        if (Date.now() > deadline) throw new Error('Timed out.');
        await new Promise(done => setTimeout(done, 25));
    }
}

/** A host in this process with a fake notifier that answers with `answer`. */
async function startHost(answer: (request: NotifyRequest) => NotifyAnswer, open?: string[]) {
    const dir = hostDir();
    const notified: NotifyRequest[] = [];
    const host = new PtyHost({ dir, open, notifier: { notify: async request => (notified.push(request), answer(request)) } });
    hosts.push(host);
    expect(await host.listen()).toBe(true);
    const client = await connectPtyHost({ dir, start: false });
    const statuses: [string, TerminalStatus][] = [];
    client.on('status', (id, status) => statuses.push([id, status]));
    return { dir, client, notified, statuses };
}

describe('status', () => {
    test('the scanner finds OSC 9 and OSC 777 notifications split over chunks, and nothing else', () => {
        const scanner = new NotificationScanner();
        expect(scanner.feed('a\x1b]9;Appr')).toEqual([]);
        expect(scanner.feed('ove?\x07b')).toEqual([{ body: 'Approve?', source: 'osc9' }]);
        expect(scanner.feed('\x1b]9;4;1;50\x07\x1b]9;9;/work\x07\x1b]0;title\x07\x1b]633;A\x07')).toEqual([]);
        expect(scanner.feed('\x1b]777;notify;Claude;Needs; you\x1b')).toEqual([]);
        expect(scanner.feed('\\')).toEqual([{ title: 'Claude', body: 'Needs; you', source: 'osc777' }]);
        // ESC cancels an open sequence and may start the next one
        expect(scanner.feed('\x1b]9;lost\x1b\x1b]9;kept\x07')).toEqual([{ body: 'kept', source: 'osc9' }]);
        expect(scanner.feed(`\x1b]52;c;${'A'.repeat(40000)}\x07\x1b]9;after\x07`)).toEqual([{ body: 'after', source: 'osc9' }]);
    });

    test('the tracker goes from running to needs input on a notification, back on input, and to exited', () => {
        let now = 1;
        const tracker = new StatusTracker(() => now++);
        expect(tracker.status).toEqual({ state: 'running', since: 1 });
        expect(tracker.input()).toBeUndefined();
        expect(tracker.output('plain')).toBeUndefined();
        expect(tracker.output('\x1b]9;Continue?\x07')).toEqual({ state: 'needsInput', since: 2, notification: { body: 'Continue?', source: 'osc9' } });
        expect(tracker.input()).toEqual({ state: 'running', since: 3 });
        expect(tracker.exit(3)).toEqual({ state: 'exited', since: 4, code: 3 });
        expect(tracker.output('\x1b]9;late\x07')).toBeUndefined();
    });

    test('the notification text and the platform commands', () => {
        expect(notificationText({ body: 'Approve?', source: 'osc9' }, { title: 'claude', group: '/work/shop', meta: { label: 'Refactor' } }))
            .toEqual({ title: 'Refactor · shop', body: 'Approve?' });
        expect(notificationText({ title: 'Codex', body: '', source: 'osc777' }, {})).toEqual({ title: 'Codex', body: 'Needs your input' });
        const request = { terminal: 't1', title: "It's", body: 'a\nb', reply: true };
        expect(notifySendArgs(request, true)).toEqual(['--app-name=Appling', '--urgency=normal', '--action=default=Open', '--action=open=Open', '--', "It's", 'a\nb']);
        expect(parseNotifySend('open\n')).toEqual({ action: 'open' });
        expect(parseNotifySend('')).toBeUndefined();
        expect(parseCapabilities("(['actions', 'body', 'inline-reply'],)\n")).toEqual(['actions', 'body', 'inline-reply']);
        expect(gvariantString("It's\n\\")).toBe("'It\\'s\\n\\\\'");
        expect(gdbusNotifyArgs(request)).toContain("['default', 'Open', 'open', 'Open', 'inline-reply', 'Reply']");
        const signal = (s: string) => `/org/freedesktop/Notifications: org.freedesktop.Notifications.${s}`;
        expect(parseMonitorLine(signal("ActionInvoked (uint32 7, 'default')"), 7)).toEqual({ action: 'open' });
        expect(parseMonitorLine(signal("NotificationReplied (uint32 7, 'yes it\\'s fine')"), 7)).toEqual({ action: 'reply', text: "yes it's fine" });
        expect(parseMonitorLine(signal('NotificationClosed (uint32 7, uint32 2)'), 7)).toBe('closed');
        expect(parseMonitorLine(signal("ActionInvoked (uint32 8, 'default')"), 7)).toBeUndefined();
        expect(osascriptArgs(request, 60).slice(-2)).toEqual(["It's", 'a\nb']);
        expect(parseOsascript('button returned:Reply, text returned:go on, gave up:false\n')).toEqual({ action: 'reply', text: 'go on' });
        expect(parseOsascript('button returned:Open, text returned:, gave up:false')).toEqual({ action: 'open' });
        expect(parseOsascript('button returned:, gave up:true')).toBeUndefined();
        expect(toastScript({ ...request, title: '<a & b>' }, 60)).toContain('&lt;a &amp; b&gt;');
        expect(parseToast('{"action":"reply","text":"ok"}')).toEqual({ action: 'reply', text: 'ok' });
        expect(parseToast('{"action":"open","text":null}')).toEqual({ action: 'open' });
        expect(parseToast('')).toBeUndefined();
    });

    test('the Linux notifier falls back to notify-send with an Open action when the server offers no inline reply', async () => {
        const calls: [string, string[]][] = [];
        const runner: Runner = async (command, args) => {
            calls.push([command, args]);
            if (command === 'gdbus') return { code: 0, stdout: "(['actions', 'body'],)", stderr: '' };
            return { code: 0, stdout: 'open\n', stderr: '' };
        };
        const answer = await systemNotifier({ platform: 'linux', run: runner }).notify({ terminal: 't', title: 'T', body: 'B', reply: true });
        expect(answer).toEqual({ action: 'open' });
        expect(calls.map(([command]) => command)).toEqual(['gdbus', 'notify-send']);
        expect(calls[1][1]).toContain('--action=open=Open');
        const mac = await systemNotifier({ platform: 'darwin', run: async (command, args) => (calls.push([command, args]), { code: 0, stdout: 'button returned:Reply, text returned:y, gave up:false', stderr: '' }) })
            .notify({ terminal: 't', title: 'T', body: 'B', reply: true });
        expect(mac).toEqual({ action: 'reply', text: 'y' });
        expect(calls.at(-1)![0]).toBe('osascript');
    });
});

describe.skipIf(process.platform === 'win32')('status in a real pty host', () => {
    test('OSC 9 makes a terminal need input; with nobody attached the host notifies, a reply goes to the pty, the exit is reported', async () => {
        const { client, notified, statuses } = await startHost(() => ({ action: 'reply', text: 'yes' }));
        const subscribed = await client.subscribe();
        expect(subscribed).toEqual([]);
        const info = await client.spawn({ ...SH, args: ASKS, cwd: tmpdir(), group: '/work/shop', meta: { preset: 'claude', label: 'Refactor' } });
        expect(info).toMatchObject({ meta: { preset: 'claude', label: 'Refactor' }, status: { state: 'running' } });
        await until(() => statuses.some(([, s]) => s.state === 'exited'));
        expect(statuses.filter(([id]) => id === info.id).map(([, s]) => s.state)).toEqual(['needsInput', 'running', 'exited']);
        expect(statuses[0][1]).toMatchObject({ notification: { body: 'Approve the plan?', source: 'osc9' } });
        expect(statuses.at(-1)![1]).toMatchObject({ state: 'exited', code: 5 });
        expect(notified).toEqual([{ terminal: info.id, title: 'Refactor · shop', body: 'Approve the plan?', reply: true }]);
        const [listed] = await client.list();
        expect(listed).toMatchObject({ status: { state: 'exited', code: 5 }, meta: { label: 'Refactor' } });
        const replay = await client.attach(info.id);
        expect(replay.scrollback).toContain('got-yes');
        const updated = await client.update(info.id, { meta: { label: 'Done', preset: null }, title: 'agent' });
        expect(updated).toMatchObject({ title: 'agent', meta: { label: 'Done' } });
        expect(updated.meta).not.toHaveProperty('preset');
        client.close();
    }, 20000);

    test('an attached client holds the notification back until it detaches; a click runs the open command', async () => {
        const opened = join(hostDir(), 'opened');
        const open = [process.execPath, '-e', 'require("fs").writeFileSync(process.argv[1], process.argv[2])', opened, '{terminal}'];
        const { client, notified, statuses } = await startHost(() => ({ action: 'open' }), open);
        const terminal = await client.spawnAttached({ ...SH, args: ASKS, cwd: tmpdir() });
        await until(async () => (await client.list())[0].status.state === 'needsInput');
        await new Promise(done => setTimeout(done, 200));
        expect(notified).toEqual([]);
        await terminal.detach();
        await until(() => notified.length === 1);
        await until(() => existsSync(opened));
        expect(readFileSync(opened, 'utf8')).toBe(terminal.id);
        // a terminal that opts out does not notify
        const quiet = await client.spawn({ ...SH, args: ASKS, cwd: tmpdir(), meta: { notify: 'off' } });
        await until(async () => (await client.list()).find(t => t.id === quiet.id)?.status.state === 'needsInput');
        await new Promise(done => setTimeout(done, 200));
        expect(notified).toHaveLength(1);
        client.close();
    }, 20000);

    test('the command host notifies through notify-send, runs the open command and lists status and metadata', async () => {
        const dir = hostDir();
        const bin = join(dir, 'bin');
        const log = join(dir, 'notify-send.log');
        const opened = join(dir, 'opened');
        // no notification server answers gdbus; notify-send records its arguments and reports a click on Open
        writeScript(join(bin, 'gdbus'), 'exit 1');
        writeScript(join(bin, 'notify-send'), `printf '%s\\n' "$@" > ${JSON.stringify(log)}; echo open`);
        const open = [process.execPath, '-e', 'require("fs").writeFileSync(process.argv[1], process.argv[2])', opened, '{terminal}'];
        const client = await connectPtyHost({ dir, host: { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, open } });
        const info = await client.spawn({ ...SH, args: ASKS, cwd: dir, group: 'shop', title: 'claude', meta: { preset: 'claude', label: 'Plan' } });
        await until(() => existsSync(opened), 10000);
        expect(readFileSync(opened, 'utf8')).toBe(info.id);
        expect(readFileSync(log, 'utf8').split('\n')).toEqual(expect.arrayContaining(['--action=open=Open', 'Plan · shop', 'Approve the plan?']));
        const { stdout } = await run(process.execPath, [hostMain(), 'list', '--dir', dir]);
        expect(stdout.trim()).toBe([info.id, 'needs input', `pid ${info.pid}`, 'shop', 'claude', 'preset=claude,label=Plan', dir].join('\t'));
        const json = JSON.parse((await run(process.execPath, [hostMain(), 'list', '--json', '--dir', dir])).stdout);
        expect(json[0]).toMatchObject({ id: info.id, status: { state: 'needsInput' }, meta: { label: 'Plan' } });
        client.write(info.id, 'no\r');
        await until(async () => (await client.list())[0].status.state === 'exited');
        expect((await run(process.execPath, [hostMain(), 'list', '--dir', dir])).stdout).toContain(`${info.id}\texited 5\t`);
        await run(process.execPath, [hostMain(), 'kill', info.id, '--dir', dir]);
        expect(await client.list()).toEqual([]);
        client.close();
    }, 30000);
});

function writeScript(path: string, body: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
}

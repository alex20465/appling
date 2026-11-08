import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectPtyHost, type NotifyRequest, type TerminalInfo } from '@appling/pty-host';
import { describe, expect, test } from 'vitest';
import { RemoteStatus } from '../src/remote/notify.js';
import { appCommand, openCommand, sessionArg, trayMode, withoutAppFlags } from '../src/app-flags.js';
import { trayEntries, trayTooltip } from '../src/tray-menu.js';

describe('app flags', () => {
    test('--session and --tray are read before -- and dropped from the paths', () => {
        expect(sessionArg(['electron', 'main.js', '--session', 't1', '--', '/work'])).toBe('t1');
        expect(sessionArg(['appling', '--session=t2'])).toBe('t2');
        expect(sessionArg(['appling', '--', '--session', 't3'])).toBeUndefined();
        expect(sessionArg(['appling', '--session', '--tray'])).toBeUndefined();
        expect(trayMode(['appling', '--tray'])).toBe(true);
        expect(trayMode(['appling', '--', '--tray'])).toBe(false);
        expect(withoutAppFlags(['appling', '--session', 't1', '--tray', 'shop', '--', '--tray'])).toEqual(['appling', 'shop', '--', '--tray']);
    });

    test('the open command starts the app at the terminal, packaged, as an AppImage or in development', () => {
        expect(openCommand({ execPath: '/x/electron', main: '/repo/out/main.js', packaged: false })).toEqual(['/x/electron', '/repo/out/main.js', '--session', '{terminal}']);
        expect(openCommand({ execPath: '/tmp/.mount_x/appling', main: '', packaged: true, appImage: '/home/u/Appling.AppImage' })).toEqual(['/home/u/Appling.AppImage', '--session', '{terminal}']);
        expect(appCommand({ execPath: '/Applications/Appling.app/Contents/MacOS/Appling', main: '', packaged: true }, [])).toEqual(['/Applications/Appling.app/Contents/MacOS/Appling']);
    });
});

describe('tray', () => {
    const terminal = (id: string, status: TerminalInfo['status'], extra: Partial<TerminalInfo> = {}): TerminalInfo => ({
        id, shell: '/bin/bash', args: [], cwd: '/work/shop', pid: 1, cols: 80, rows: 24, created: Number(id.slice(1)), attached: 0, status, ...extra
    });

    test('lists the sessions waiting for input first, with their label, repo and status', () => {
        const list = [
            terminal('t1', { state: 'exited', since: 1, code: 3 }, { group: '/work/shop' }),
            terminal('t2', { state: 'running', since: 1 }, { group: '/work/shop', title: 'build' }),
            terminal('t3', { state: 'needsInput', since: 1, notification: { body: 'Approve?', source: 'osc9' } }, { group: '/work/crm', title: 'claude', meta: { label: 'Refactor' } })
        ];
        expect(trayEntries(list)).toEqual([
            { id: 't3', label: 'Refactor · crm', status: 'needs input', needsInput: true, running: true },
            { id: 't2', label: 'build · shop', status: 'running', needsInput: false, running: true },
            { id: 't1', label: 'bash · shop', status: 'exited 3', needsInput: false, running: false }
        ]);
        expect(trayTooltip(list, true)).toBe('Appling: 2 sessions running, 1 needs input');
        expect(trayTooltip([], false)).toBe('Appling: no sessions running');
    });
});

describe.skipIf(process.platform === 'win32')('remote terminal status', () => {
    test('a remote host without notifications: the app notifies for a terminal nobody attached to, a reply reaches the pty', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'pty-'));
        const until = async (check: () => boolean | Promise<boolean>) => {
            for (const deadline = Date.now() + 10000; !await check();) {
                if (Date.now() > deadline) throw new Error('Timed out.');
                await new Promise(done => setTimeout(done, 25));
            }
        };
        // the remote side: a host started as remote/agent.ts does, with notify: false
        const remote = await connectPtyHost({ dir, host: { notify: false } });
        try {
            const notified: NotifyRequest[] = [];
            const opened: string[] = [];
            let answer: 'reply' | 'open' = 'open';
            const status = new RemoteStatus({
                notifier: { notify: async request => (notified.push(request), answer === 'reply' ? { action: 'reply', text: 'yes' } : { action: 'open' }) },
                open: (repo, terminal) => opened.push(`${repo} ${terminal}`)
            });
            const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: tmpdir() };
            // the exit status tells what the program read: 7 for the reply "yes", else 5
            const ask = ['-c', 'printf "\\033]9;Approve?\\007"; read a; echo "got-$a"; [ "$a" = yes ] && exit 7; exit 5'];
            // one that waited before the app connected, one that a view shows (attached: no notification)
            const before = await remote.spawn({ shell: '/bin/sh', args: ask, cwd: dir, env, group: '/srv/shop', meta: { label: 'Plan' } });
            await until(async () => (await remote.list()).find(t => t.id === before.id)?.status.state === 'needsInput');
            await status.watch('ssh://box/srv/shop', dir);
            await until(() => opened.length === 1);
            expect(opened).toEqual([`ssh://box/srv/shop ${before.id}`]);
            expect(notified[0]).toMatchObject({ terminal: before.id, title: 'Plan · shop', body: 'Approve?' });
            const shown = await remote.spawnAttached({ shell: '/bin/sh', args: ask, cwd: dir, env });
            answer = 'reply';
            const later = await remote.spawn({ shell: '/bin/sh', args: ask, cwd: dir, env });
            // the reply reached the pty: the program read it and exited with 7
            await until(async () => (await remote.list()).find(t => t.id === later.id)?.status.state === 'exited');
            expect((await remote.list()).find(t => t.id === later.id)?.exit).toEqual({ code: 7 });
            expect(notified.map(n => n.terminal)).toEqual([before.id, later.id]);
            expect((await remote.attach(later.id)).scrollback).toContain('got-yes');
            // watched again, as after a reconnect: the wait already notified is not raised again
            await status.watch('ssh://box/srv/shop', dir);
            expect(notified.map(n => n.terminal)).toEqual([before.id, later.id]);
            expect(shown.id).toBeTruthy();
            status.close();
        } finally {
            await remote.shutdown().catch(() => undefined);
            rmSync(dir, { recursive: true, force: true });
        }
    }, 30000);
});

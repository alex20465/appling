import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PtyHostClient } from '@appling/pty-host';
import { afterAll, describe, expect, test } from 'vitest';
import { DEFAULT_KEYBINDINGS } from '../src/keybindings.js';
import { commandFor, matches } from '../src/terminal/keys.js';
import { findFileLinks, isWebUrl, offsetAt } from '../src/terminal/links.js';
import { substitute, terminalProfiles, vscodeSettingsFiles, type ProfileContext } from '../src/terminal/profiles.js';
import { DEFAULT_HEIGHT, MAX_HEIGHT, TerminalRegistry } from '../src/terminal/registry.js';
import { SCRIPTS, TerminalService, terminalEnv } from '../src/terminal/service.js';
import { DEFAULT_TERMINAL_SETTINGS, readSettingsFile, terminalSettings, writeSetting, type TerminalSettings } from '../src/terminal/settings.js';
import { decodeValue, injectShellIntegration, OscScanner, ShellIntegration, shellKind, type IntegrationEvent } from '../src/terminal/shell-integration.js';

const ESC = '\x1b', BEL = '\x07', ST = '\x1b\\';
const temps: string[] = [];
function temp(prefix = 'term-'): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    temps.push(dir);
    return dir;
}

describe('OSC scanner', () => {
    test('finds the sequences it wants, ended by BEL or ST, across chunks', () => {
        const scanner = new OscScanner();
        expect(scanner.feed(`hello ${ESC}]633;A${BEL}$ ${ESC}]633;B${ST}`)).toEqual([{ code: 633, data: 'A' }, { code: 633, data: 'B' }]);
        const input = `${ESC}]633;E;ls -la${BEL}${ESC}]633;C${BEL}out${ESC}]633;D;0${ST}`;
        const found = [...input].flatMap(c => scanner.feed(c));
        expect(found).toEqual([{ code: 633, data: 'E;ls -la' }, { code: 633, data: 'C' }, { code: 633, data: 'D;0' }]);
        expect(scanner.idle).toBe(true);
    });

    test('skips other codes, huge payloads and sequences that ESC cancels', () => {
        const scanner = new OscScanner();
        expect(scanner.feed(`${ESC}]0;title${BEL}${ESC}]52;c;${'A'.repeat(200_000)}${BEL}${ESC}]9;hi${BEL}`)).toEqual([{ code: 9, data: 'hi' }]);
        expect(scanner.feed(`${ESC}]633;A${ESC}[0m${ESC}]7;file:///tmp${BEL}`)).toEqual([{ code: 7, data: 'file:///tmp' }]);
        expect(scanner.feed(`${ESC}]633;${'x'.repeat(70_000)}${BEL}${ESC}]633;A${BEL}`)).toEqual([{ code: 633, data: 'A' }]);
        expect(scanner.feed(`${ESC}]633${BEL}`)).toEqual([{ code: 633, data: '' }]);
    });
});

describe('shell integration', () => {
    test('decodes escaped values', () => {
        expect(decodeValue('echo a\\x3bb \\\\ c\\x0ad')).toBe('echo a;b \\ c\nd');
    });

    test('records commands with their exit status and working directory', () => {
        const shell = new ShellIntegration('/home');
        const events: IntegrationEvent[] = [];
        const feed = (text: string, now: number) => events.push(...shell.feed(text, now));
        feed(`${ESC}]633;P;Cwd=/work${BEL}${ESC}]633;A${BEL}$ ${ESC}]633;B${BEL}`, 1);
        expect(shell.active).toBe(true);
        expect(shell.cwd).toBe('/work');
        feed(`${ESC}]633;E;false \\x3b echo${BEL}${ESC}]633;C${BEL}`, 2);
        expect(shell.running).toEqual({ command: 'false ; echo', cwd: '/work', started: 2 });
        feed(`${ESC}]633;D;1${BEL}${ESC}]633;P;Cwd=/work/a\\x3bb${BEL}${ESC}]633;A${BEL}`, 5);
        expect(shell.running).toBeUndefined();
        expect(shell.commands).toEqual([{ command: 'false ; echo', cwd: '/work', exitCode: 1, started: 2, ended: 5 }]);
        expect(shell.cwd).toBe('/work/a;b');
        expect(events.map(e => e.type)).toEqual(['cwd', 'prompt', 'commandStarted', 'commandFinished', 'cwd', 'prompt']);
        // D without a running command (an empty line) and C without E (PS0) still work
        feed(`${ESC}]633;D${BEL}${ESC}]633;C${BEL}${ESC}]633;D${BEL}`, 7);
        expect(shell.commands.at(-1)).toEqual({ cwd: '/work/a;b', started: 7, ended: 7 });
    });

    test('reads OSC 7, OSC 9 and OSC 777', () => {
        const shell = new ShellIntegration();
        expect(shell.feed(`${ESC}]7;file://host/home/me/a%20b${BEL}`)).toEqual([{ type: 'cwd', cwd: '/home/me/a b' }]);
        expect(shell.feed(`${ESC}]9;Build done${BEL}${ESC}]777;notify;Claude;Needs input; now${BEL}`)).toEqual([
            { type: 'notification', notification: { body: 'Build done', source: 'osc9' } },
            { type: 'notification', notification: { title: 'Claude', body: 'Needs input; now', source: 'osc777' } }
        ]);
        expect(shell.feed(`${ESC}]9;4;1;40${BEL}${ESC}]9;4;0${BEL}${ESC}]9;9;"C:\\work"${BEL}${ESC}]9;1;100${BEL}`)).toEqual([
            { type: 'progress', state: 1, value: 40 }, { type: 'progress', state: 0 }, { type: 'cwd', cwd: 'C:\\work' }
        ]);
        expect(shell.active).toBe(false);
    });

    test('injects the scripts of bash, zsh and fish, and leaves other launches alone', () => {
        const env = { HOME: '/home/me', PATH: '/bin' };
        expect(shellKind('/usr/bin/bash')).toBe('bash');
        expect(shellKind('C:\\Git\\bin\\bash.exe')).toBe('bash');
        expect(shellKind('/bin/sh')).toBeUndefined();
        const bash = injectShellIntegration({ shell: '/bin/bash', args: ['-l'], env }, '/s');
        expect(bash).toMatchObject({ injected: true, args: ['--init-file', '/s/bash/appling.bash', '-i'], env: { APPLING_SHELL_LOGIN: '1', HOME: '/home/me' } });
        expect(injectShellIntegration({ shell: '/bin/bash', args: [], env }, '/s').env.APPLING_SHELL_LOGIN).toBeUndefined();
        const zsh = injectShellIntegration({ shell: '/bin/zsh', args: ['-l'], env: { ...env, ZDOTDIR: '/home/me/.config/zsh' } }, '/s');
        expect(zsh).toMatchObject({ injected: true, args: ['-l', '-i'], env: { ZDOTDIR: '/s/zsh', APPLING_USER_ZDOTDIR: '/home/me/.config/zsh' } });
        expect(injectShellIntegration({ shell: '/bin/zsh', args: [], env }, '/s').env.APPLING_USER_ZDOTDIR).toBe('/home/me');
        expect(injectShellIntegration({ shell: '/usr/bin/fish', args: [], env }, "/it's").args).toEqual(['-i', '--init-command', "source '/it\\'s/fish/appling.fish'"]);
        expect(injectShellIntegration({ shell: '/bin/bash', args: ['-c', 'make'], env }, '/s')).toMatchObject({ injected: false, args: ['-c', 'make'] });
        expect(injectShellIntegration({ shell: '/bin/sh', args: [], env }, '/s').injected).toBe(false);
    });
});

describe('profiles', () => {
    const context = (overrides: Partial<ProfileContext> = {}): ProfileContext => ({
        platform: 'linux',
        env: { SHELL: '/usr/bin/zsh', HOME: '/home/me', PATH: '/usr/local/bin:/usr/bin' },
        exists: path => ['/usr/bin/zsh', '/bin/bash', '/usr/bin/bash', '/usr/bin/fish', '/usr/local/bin/nu', '/usr/sbin/nologin', '/bin/sh', '/home/me/.local/bin/fish'].includes(path),
        shells: '# /etc/shells\n/bin/sh\n/bin/bash\n/usr/bin/bash\n/usr/bin/zsh\n/usr/sbin/nologin\n/opt/missing/ksh\n',
        settings: [],
        ...overrides
    });

    test('come from $SHELL and /etc/shells, the shell of $SHELL is the default', () => {
        const { profiles, default: chosen, problems } = terminalProfiles(context());
        expect(profiles.map(p => [p.name, p.path])).toEqual([['zsh', '/usr/bin/zsh'], ['sh', '/bin/sh'], ['bash', '/bin/bash']]);
        expect(chosen).toBe('zsh');
        expect(problems).toEqual([]);
    });

    test("VS Code's profile settings add, change and remove profiles and pick the default", () => {
        const { profiles, default: chosen, problems } = terminalProfiles(context({
            workspaceFolder: '/work/shop',
            settings: [
                {
                    'terminal.integrated.profiles.linux': {
                        bash: { path: 'bash', args: ['-l'], icon: 'terminal-bash' },
                        sh: null,
                        nu: { path: ['/opt/nu', 'nu'], env: { NU_DIR: '${workspaceFolder}/.nu', DROP: null } },
                        tmux: { path: '/usr/bin/tmux' },
                        broken: 'yes'
                    },
                    'terminal.integrated.profiles.osx': { mac: { path: '/bin/zsh' } },
                    'terminal.integrated.defaultProfile.linux': 'bash'
                },
                { 'terminal.integrated.profiles.linux': { fish: { path: '${env:HOME}/.local/bin/fish', overrideName: true } } }
            ]
        }));
        expect(profiles.map(p => p.name)).toEqual(['zsh', 'bash', 'nu', 'fish']);
        expect(profiles.find(p => p.name === 'bash')).toEqual({ name: 'bash', path: '/usr/bin/bash', args: ['-l'], icon: 'terminal-bash', source: 'settings' });
        expect(profiles.find(p => p.name === 'nu')?.env).toEqual({ NU_DIR: '/work/shop/.nu', DROP: null });
        expect(profiles.find(p => p.name === 'fish')?.path).toBe('/home/me/.local/bin/fish');
        expect(chosen).toBe('bash');
        expect(problems).toEqual(['profile "tmux": none of /usr/bin/tmux exists', 'profile "broken": expected an object or null']);
        // Appling's own default wins over VS Code's; an unknown name falls back
        expect(terminalProfiles(context({ settings: [{ 'terminal.integrated.defaultProfile.linux': 'bash' }, { 'terminal.defaultProfile': 'sh' }] })).default).toBe('sh');
        expect(terminalProfiles(context({ settings: [{ 'terminal.defaultProfile': 'nope' }] })).default).toBe('zsh');
    });

    test('Windows finds PowerShell, the Command Prompt and Git Bash, and profiles by source', () => {
        const files = ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'C:\\Windows\\System32\\cmd.exe', 'C:\\Program Files\\Git\\bin\\bash.exe'];
        const { profiles, default: chosen } = terminalProfiles({
            platform: 'win32',
            env: { Path: 'C:\\Program Files\\PowerShell\\7;C:\\Windows', SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe', ProgramFiles: 'C:\\Program Files', USERPROFILE: 'C:\\Users\\me' },
            exists: path => files.includes(path),
            settings: [{ 'terminal.integrated.profiles.windows': { 'Dev Shell': { source: 'PowerShell', args: ['-NoLogo'] } } }]
        });
        expect(profiles.map(p => [p.name, p.path, p.args])).toEqual([
            ['PowerShell', files[0], []], ['Command Prompt', files[1], []], ['Git Bash', files[2], ['--login', '-i']], ['Dev Shell', files[0], ['-NoLogo']]
        ]);
        expect(chosen).toBe('PowerShell');
    });

    test('variables and settings files', () => {
        const c = context({ workspaceFolder: '/w' });
        expect(substitute('${userHome}${pathSeparator}x ${env:PATH} ${workspaceFolder} ${env:NONE}.', c)).toBe('/home/me/x /usr/local/bin:/usr/bin /w .');
        expect(vscodeSettingsFiles('linux', {}, '/home/me')[0]).toBe('/home/me/.config/Code/User/settings.json');
        expect(vscodeSettingsFiles('darwin', {}, '/Users/me')[0]).toBe('/Users/me/Library/Application Support/Code/User/settings.json');
    });
});

describe('terminal settings', () => {
    test("Appling's settings over VS Code's over the defaults; wrong values are reported", () => {
        expect(terminalSettings({}).settings).toEqual(DEFAULT_TERMINAL_SETTINGS);
        const { settings, problems } = terminalSettings(
            { 'terminal.endWithApp': true, 'terminal.fontSize': 400, 'terminal.scrollback': 500, 'terminal.defaultProfile': '' },
            { 'terminal.integrated.fontSize': 15, 'terminal.integrated.fontFamily': 'Fira Code', 'terminal.integrated.scrollback': 'lots', 'terminal.integrated.shellIntegration.enabled': false }
        );
        expect(settings).toMatchObject({ endWithApp: true, fontSize: 13, fontFamily: 'Fira Code', scrollback: 500, shellIntegration: false });
        expect(settings.defaultProfile).toBeUndefined();
        expect(problems).toEqual(['"terminal.defaultProfile" must be a non empty string', '"terminal.fontSize" must be a number from 6 to 72']);
    });

    test('a setting is written into the file, keeping the others', () => {
        const file = join(temp(), 'settings.json');
        writeSetting(file, 'terminal.endWithApp', true);
        writeFileSync(file, '{\n  // mine\n  "other": 1,\n  "terminal.endWithApp": true,\n}\n');
        writeSetting(file, 'terminal.endWithApp', false);
        expect(readSettingsFile(file)).toEqual({ settings: { other: 1, 'terminal.endWithApp': false }, problems: [] });
        writeFileSync(file, '{ broken');
        expect(readSettingsFile(file).problems).toHaveLength(1);
        expect(() => writeSetting(file, 'terminal.endWithApp', true)).toThrow();
    });
});

describe('terminal registry', () => {
    test('tabs, splits, focus and closing per repo', () => {
        const registry = new TerminalRegistry();
        registry.add('/shop', 'a');
        registry.add('/shop', 'b');
        registry.add('/shop', 'c', { split: true, name: 'server' });
        registry.add('/crm', 'x');
        expect(registry.get('/shop')).toMatchObject({
            tabs: [{ id: 'a', panes: ['a'], active: 'a' }, { id: 'b', panes: ['b', 'c'], active: 'c' }],
            active: 'b', open: true, names: { c: 'server' }
        });
        expect(registry.repoOf('x')).toBe('/crm');
        expect(registry.terminals('/shop')).toEqual(['a', 'b', 'c']);
        expect(registry.focus('a')).toBe(true);
        expect(registry.focused('/shop')).toBe('a');
        registry.add('/shop', 'd');
        expect(registry.get('/shop').tabs.map(t => t.id)).toEqual(['a', 'd', 'b']);
        expect(registry.moveTab('/shop', 'b', 0)).toBe(true);
        expect(registry.get('/shop').tabs.map(t => t.id)).toEqual(['b', 'a', 'd']);
        expect(registry.cycleTab('/shop', 1)).toBe(true);
        expect(registry.get('/shop').active).toBe('b');

        expect(registry.remove('c')).toBe('/shop');
        expect(registry.get('/shop').tabs[0]).toEqual({ id: 'b', panes: ['b'], active: 'b' });
        expect(registry.get('/shop').names).toEqual({});
        registry.remove('b');
        expect(registry.get('/shop').active).toBe('a');
        registry.remove('a');
        registry.remove('d');
        expect(registry.get('/shop')).toMatchObject({ tabs: [], open: false });
        expect(registry.remove('nope')).toBeUndefined();
    });

    test('survives a round trip and reconciles with the pty host', () => {
        const registry = new TerminalRegistry();
        registry.add('/shop', 'a');
        registry.add('/shop', 'b', { split: true });
        registry.add('/shop', 'c');
        registry.setHeight('/shop', 5);
        registry.rename('a', ' build ');
        const copy = TerminalRegistry.from(JSON.parse(JSON.stringify(registry)));
        expect(copy.get('/shop')).toEqual(registry.get('/shop'));
        expect(copy.get('/shop')).toMatchObject({ height: MAX_HEIGHT, names: { a: 'build' } });
        expect(copy.get('/none')).toEqual({ tabs: [], open: false, height: DEFAULT_HEIGHT, names: {} });
        // b ended while the app was closed, z was started by someone else
        expect(copy.reconcile('/shop', ['z', 'c', 'a'])).toBe(true);
        expect(copy.get('/shop').tabs.map(t => t.panes)).toEqual([['a'], ['c'], ['z']]);
        expect(copy.reconcile('/shop', ['z', 'c', 'a'])).toBe(false);
        expect(TerminalRegistry.from({ repos: { '/x': { tabs: [{ id: 1 }, { id: 'k', panes: [] }], open: 'yes' } } }).get('/x')).toMatchObject({ tabs: [], open: false });
        expect(TerminalRegistry.from('garbage').all()).toEqual([]);
    });
});

describe('links', () => {
    test('finds file paths with line and column, not URLs or version numbers', () => {
        const paths = (text: string) => findFileLinks(text).map(l => [text.slice(l.start, l.end), l.path, l.line, l.column]);
        expect(paths('error in src/main.ts:12:5 here')).toEqual([['src/main.ts:12:5', 'src/main.ts', 12, 5]]);
        expect(paths('open ./notes.txt.')).toEqual([['./notes.txt', './notes.txt', undefined, undefined]]);
        expect(paths('cat /etc/hosts and ~/a.md')).toEqual([['/etc/hosts', '/etc/hosts', undefined, undefined], ['~/a.md', '~/a.md', undefined, undefined]]);
        expect(paths('File "src/app.py", line 12, in run')).toEqual([['src/app.py", line 12', 'src/app.py', 12, undefined]]);
        expect(paths('src\\a.ts(3,4): error')).toEqual([['src\\a.ts(3,4)', 'src\\a.ts', 3, 4]]);
        expect(paths('see https://example.com/a/b.ts:3 ok')).toEqual([]);
        expect(paths('version 1.2.3 and a/b and ok.')).toEqual([]);
        expect(paths('packages/desktop/README.md')).toEqual([['packages/desktop/README.md', 'packages/desktop/README.md', undefined, undefined]]);
        expect(offsetAt('ab\ncde\nf', 2, 2)).toBe(4);
        expect(offsetAt('ab\ncde\nf', 2, 99)).toBe(6);
        expect(offsetAt('ab\ncde\nf', 9)).toBe(8);
        expect(offsetAt('ab\ncde\nf')).toBe(0);
        expect(isWebUrl('https://x.org')).toBe(true);
        expect(isWebUrl('file:///etc/passwd')).toBe(false);
    });
});

describe('keys in a terminal', () => {
    const key = (key: string, code: string, mods: Partial<{ control: boolean, shift: boolean, alt: boolean, meta: boolean }> = {}) =>
        ({ type: 'keyDown', key, code, control: false, shift: false, alt: false, meta: false, ...mods });

    test('only the skip-shell commands leave the terminal', () => {
        const bindings = DEFAULT_KEYBINDINGS;
        expect(commandFor(key('Tab', 'Tab', { control: true }), bindings, false)).toBe('nextRepo');
        expect(commandFor(key('`', 'Backquote', { control: true }), bindings, false)).toBe('toggleTerminal');
        expect(commandFor(key('%', 'Digit5', { control: true, shift: true }), bindings, false)).toBe('splitTerminal');
        expect(commandFor(key('%', 'Digit5', { meta: true, shift: true }), bindings, true)).toBe('splitTerminal');
        // Ctrl+R, Ctrl+W, Ctrl+B belong to the shell even though the menu binds them
        for (const letter of ['r', 'w', 'b', 'p', 'e', 'k']) expect(commandFor(key(letter, `Key${letter.toUpperCase()}`, { control: true }), bindings, false)).toBeUndefined();
        expect(matches('CmdOrCtrl+PageDown', key('PageDown', 'PageDown', { control: true }), false)).toBe(true);
        expect(matches('Ctrl+Tab', { ...key('Tab', 'Tab', { control: true }), type: 'keyUp' }, false)).toBe(false);
        expect(matches('Bogus+X', key('x', 'KeyX'), false)).toBe(false);
    });
});

test('the environment of a terminal', () => {
    const env = terminalEnv({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', TERM_PROGRAM: 'vscode', TERM_PROGRAM_VERSION: '1.99', KEEP: 'x' }, [{ DROP: 'y', KEEP: null }, { A: 'b' }], '0.1.0');
    expect(env).toEqual({ PATH: '/bin', DROP: 'y', A: 'b', TERM_PROGRAM: 'Appling', TERM_PROGRAM_VERSION: '0.1.0', COLORTERM: 'truecolor' });
});

describe.skipIf(process.platform === 'win32')('terminal service against a pty host', { timeout: 30000 }, () => {
    const hosts: string[] = [];
    afterAll(async () => {
        for (const dir of hosts) {
            const client = await PtyHostClient.connect(dir).catch(() => undefined);
            await client?.shutdown().catch(() => undefined);
        }
        for (const dir of temps) rmSync(dir, { recursive: true, force: true });
    });

    async function until<T>(check: () => T | undefined | false, debug?: () => string, timeout = 10000): Promise<T> {
        const deadline = Date.now() + timeout;
        for (;;) {
            const value = check();
            if (value) return value;
            if (Date.now() > deadline) throw new Error(`Timed out.${debug ? `\n${debug()}` : ''}`);
            await new Promise(done => setTimeout(done, 25));
        }
    }

    function setup(settings: Partial<TerminalSettings> = {}) {
        const host = temp('pty-');
        hosts.push(host);
        const home = temp('home-');
        const data = temp('data-');
        const make = (overrides: Partial<TerminalSettings> = settings) => new TerminalService({
            // no desktop notifications from the test hosts
            host: { dir: host, host: { notify: false } },
            registryFile: join(data, 'terminals.json'),
            settings: () => ({ ...DEFAULT_TERMINAL_SETTINGS, ...overrides }),
            profiles: () => ({ profiles: [{ name: 'bash', path: '/bin/bash', args: [], source: 'detected' }, { name: 'sh', path: '/bin/sh', args: [], source: 'detected' }], default: 'bash', problems: [] }),
            env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, PS1: '$ ', ELECTRON_RUN_AS_NODE: '1' },
            version: 'test'
        });
        return { host, home, data, make };
    }

    test('bash with shell integration reports commands, exit status and the working directory', async () => {
        const { home, make } = setup();
        writeFileSync(join(home, '.bashrc'), 'export FROM_BASHRC=yes\n');
        const service = make();
        const events: IntegrationEvent[] = [];
        let output = '';
        service.on('event', (_, event) => events.push(event));
        service.on('data', (_, data) => output += data);
        const terminal = await service.create(home);
        expect(terminal).toMatchObject({ repo: home, name: 'bash', command: false });
        await until(() => events.some(e => e.type === 'prompt'), () => JSON.stringify(output));
        service.write(terminal.id, 'echo "rc=$FROM_BASHRC program=$TERM_PROGRAM"; cd /tmp && false\r');
        const finished = await until(() => events.find(e => e.type === 'commandFinished'));
        expect(finished).toMatchObject({ command: { command: 'echo "rc=$FROM_BASHRC program=$TERM_PROGRAM"; cd /tmp && false', cwd: home, exitCode: 1 } });
        expect(output).toContain('rc=yes program=Appling');
        await until(() => service.state(terminal.id)?.cwd === '/tmp');
        service.write(terminal.id, 'true\r');
        await until(() => service.commands(terminal.id).length === 2);
        expect(service.commands(terminal.id)[1]).toMatchObject({ command: 'true', cwd: '/tmp', exitCode: 0 });
        expect(service.state(terminal.id)).toMatchObject({ integration: true, last: { exitCode: 0 } });
        // a clean exit closes the tab
        service.write(terminal.id, 'exit\r');
        await until(() => !service.registry.terminals(home).length);
        service.dispose();
    });

    test('agent sessions run a command with extra environment and report notifications and the exit status', async () => {
        const { home, make } = setup();
        const service = make();
        const session = await service.createSession(home, {
            name: 'claude', command: '/bin/sh',
            args: ['-c', 'printf "\\033]9;Waiting for you\\007"; sleep 0.2; printf "\\033]777;notify;Agent;$AGENT_ID done\\033\\\\"; read line; exit 3'],
            env: { AGENT_ID: 's1' }
        });
        expect(session.state).toMatchObject({ name: 'claude', command: true });
        const notifications: unknown[] = [];
        session.onNotification(n => notifications.push(n));
        const exit = new Promise(done => session.onExit(done));
        await until(() => notifications.length === 2);
        expect(notifications).toEqual([{ body: 'Waiting for you', source: 'osc9' }, { title: 'Agent', body: 's1 done', source: 'osc777' }]);
        session.write('\r');
        expect(await exit).toEqual({ code: 3 });
        // a program that ended keeps its tab to be read
        expect(service.registry.terminals(home)).toEqual([session.id]);
        expect(service.layout(home).terminals[session.id]).toMatchObject({ exit: { code: 3 } });
        await session.kill();
        expect(service.registry.terminals(home)).toEqual([]);
        service.dispose();
    });

    test('endWithApp ends agent sessions too, and their metadata reaches the pty host', async () => {
        const { host, home, make } = setup({ endWithApp: true });
        const service = make();
        const session = await service.createSession(home, { name: 'claude', command: '/bin/sh', args: ['-c', 'sleep 30'], meta: { preset: 'claude', label: 'Refactor' } });
        const shell = await service.create(home, { profile: 'sh' });
        expect(session.state).toMatchObject({ meta: { preset: 'claude', label: 'Refactor' } });
        const client = await PtyHostClient.connect(host);
        expect((await client.list(home)).map(t => [t.id, t.meta])).toEqual([[session.id, { preset: 'claude', label: 'Refactor' }], [shell.id, undefined]]);
        await service.endAll();
        expect(await client.list(home)).toEqual([]);
        client.close();
        service.dispose();
    });

    test('terminals outlive the service and reattach with their tabs and scrollback', async () => {
        const { host, home, data, make } = setup();
        const first = make();
        const one = await first.create(home, { profile: 'sh' });
        const two = await first.create(home, { profile: 'sh', split: true, name: 'second' });
        let output = '';
        first.on('data', (id, chunk) => id === one.id && (output += chunk));
        first.write(one.id, 'echo kept-$((40+2))\r');
        await until(() => output.includes('kept-42'));
        first.dispose();
        expect(JSON.parse(readFileSync(join(data, 'terminals.json'), 'utf8')).repos[home].tabs).toEqual([{ id: one.id, panes: [one.id, two.id], active: two.id }]);

        const second = make();
        await second.openRepo(home);
        const layout = second.layout(home);
        expect(layout.tabs).toEqual([{ id: one.id, panes: [one.id, two.id], active: two.id }]);
        expect(layout.terminals[two.id].name).toBe('second');
        const snapshot = await second.snapshot(one.id, { cols: 100, rows: 30 });
        expect(snapshot.scrollback).toContain('kept-42');
        let after = '';
        second.on('data', (id, chunk) => id === one.id && (after += chunk));
        snapshot.resume();
        second.write(one.id, 'echo again\r');
        await until(() => after.includes('again'));
        await expect(second.create(home, { profile: 'nope' })).rejects.toThrow('no terminal profile "nope"');
        second.dispose();

        // with endWithApp the leftovers of a run that did not end them are ended at the next start
        const third = make({ endWithApp: true });
        await third.openRepo(home);
        expect(third.registry.terminals(home)).toEqual([]);
        const client = await PtyHostClient.connect(host);
        expect(await client.list(home)).toEqual([]);
        client.close();
        const own = await third.create(home, { profile: 'sh' });
        await third.endAll();
        expect(third.registry.terminals(home)).toEqual([]);
        expect(own.id).toBeTruthy();
        third.dispose();
    });

    test('the scripts are found next to the module', () => {
        expect(readFileSync(join(SCRIPTS, 'bash', 'appling.bash'), 'utf8')).toContain('633;D');
    });
});

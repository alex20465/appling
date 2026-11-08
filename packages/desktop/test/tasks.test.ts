import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PtyHostClient } from '@appling/pty-host';
import { afterAll, describe, expect, test } from 'vitest';
import { RailStatus } from '../src/rail-status.js';
import { applingCli, builtinTasks, RELEASE_INPUT } from '../src/tasks/builtin.js';
import { combineTasks, parseTasksJson, KNOWN_BACKGROUND } from '../src/tasks/definitions.js';
import { dependencyPlan, executePlan, planLabels } from '../src/tasks/plan.js';
import { TaskRunner } from '../src/tasks/runner.js';
import { BackgroundMatcher, IDLE, readTaskStore, settled, stripEscapes, taskContributions, transition, type TaskState } from '../src/tasks/state.js';
import { inputsUsed, quote, resolveVariables, taskLaunch, type VariableContext } from '../src/tasks/variables.js';
import { TerminalService } from '../src/terminal/service.js';
import { DEFAULT_TERMINAL_SETTINGS } from '../src/terminal/settings.js';

const temps: string[] = [];
function temp(prefix = 'tasks-'): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    temps.push(dir);
    return dir;
}

const TASKS = `{
    // VS Code's tasks, with comments and trailing commas
    "version": "2.0.0",
    "options": { "env": { "GLOBAL": "1", "SHARED": "global" } },
    "linux": { "options": { "env": { "PLATFORM": "linux" } } },
    "tasks": [
        {
            "label": "build",
            "type": "shell",
            "command": "make",
            "args": ["all", "with space", { "value": "it's", "quoting": "strong" }],
            "options": { "cwd": "\${workspaceFolder}/src", "env": { "SHARED": "task" } },
            "group": { "kind": "build", "isDefault": true },
            "windows": { "command": "nmake" },
        },
        {
            "label": "watch",
            "type": "process",
            "command": "tsc",
            "args": ["-w"],
            "isBackground": true,
            "problemMatcher": {
                "owner": "ts",
                "background": { "activeAtBeginning": true, "beginsPattern": "^start", "endsPattern": { "regexp": "^done" } }
            },
            "runOptions": { "runOn": "folderOpen" },
            "presentation": { "reveal": "silent", "close": true }
        },
        { "label": "tsc", "type": "shell", "command": "tsc -w", "isBackground": true, "problemMatcher": "$tsc-watch" },
        { "label": "all", "dependsOn": ["build", "watch"], "dependsOrder": "sequence", "detail": "everything" },
        { "type": "npm", "script": "dev" },
        { "label": "ext", "type": "gulp", "task": "x" },
        { "label": "build", "type": "shell", "command": "again" },
        { "type": "shell", "command": "nolabel" },
        { "label": "empty" },
        { "label": "ask", "type": "process", "command": "echo", "args": ["\${input:name}", "\${input:env}"], "hide": true },
    ],
    "inputs": [
        { "id": "name", "type": "promptString", "description": "Your name", "default": "me" },
        { "id": "env", "type": "pickString", "options": ["dev", { "label": "Prod", "value": "prod" }] },
        { "id": "cmd", "type": "command", "command": "x" }
    ]
}`;

describe('tasks.json', () => {
    test('reads shell and process tasks with the global, task and platform properties merged', () => {
        const { tasks, inputs, problems } = parseTasksJson(TASKS, 'linux');
        expect(tasks.map(t => t.label)).toEqual(['build', 'watch', 'tsc', 'all', 'npm: dev', 'ask']);
        const build = tasks[0];
        expect(build).toMatchObject({
            type: 'shell', command: 'make', cwd: '${workspaceFolder}/src',
            env: { GLOBAL: '1', SHARED: 'task', PLATFORM: 'linux' }, group: { kind: 'build', isDefault: true }, isBackground: false, runOn: 'default'
        });
        expect(build.args).toEqual(['all', 'with space', { value: "it's", quoting: 'strong' }]);
        expect(parseTasksJson(TASKS, 'win32').tasks[0].command).toBe('nmake');
        expect(parseTasksJson(TASKS, 'win32').tasks[0].env).toEqual({ GLOBAL: '1', SHARED: 'task' });
        expect(tasks[1]).toMatchObject({
            type: 'process', isBackground: true, runOn: 'folderOpen', presentation: { reveal: 'silent', close: true },
            background: { activeAtBeginning: true, begins: ['^start'], ends: ['^done'] }
        });
        expect(tasks[2].background).toMatchObject({ ends: KNOWN_BACKGROUND['$tsc-watch'].ends });
        expect(tasks[3]).toMatchObject({ dependsOn: ['build', 'watch'], dependsOrder: 'sequence', detail: 'everything' });
        expect(tasks[3].command).toBeUndefined();
        expect(tasks[4]).toMatchObject({ type: 'shell', command: 'npm', args: ['run', 'dev'] });
        expect(tasks[5].hide).toBe(true);
        expect(inputs).toEqual([
            { id: 'name', type: 'promptString', description: 'Your name', default: 'me' },
            { id: 'env', type: 'pickString', options: ['dev', 'prod'] }
        ]);
        expect(problems).toEqual([
            expect.stringContaining('"ext" has type gulp'),
            expect.stringContaining('two tasks labelled "build"'),
            'Task 8 has no label.',
            expect.stringContaining('"empty" has neither'),
            expect.stringContaining('Input "cmd" has type command')
        ]);
    });

    test('a broken file has no tasks and says why', () => {
        expect(parseTasksJson('{ "tasks": [', 'linux')).toMatchObject({ tasks: [], problems: [expect.stringContaining('not valid JSON')] });
        expect(parseTasksJson('[]', 'linux').problems).toEqual(['The tasks file holds no object.']);
        expect(parseTasksJson('{ "version": "0.1.0", "tasks": [] }', 'linux').problems[0]).toContain('Version 0.1.0');
    });

    test('folder tasks come before workspace tasks and built in ones of the same label', () => {
        const folder = parseTasksJson('{ "tasks": [{ "label": "appling: check", "command": "mine" }] }', 'linux');
        const builtin = builtinTasks({ command: 'appling', args: [], env: {} });
        const combined = combineTasks(folder, builtin);
        expect(combined.tasks.map(t => [t.label, t.source])).toEqual([['appling: check', 'folder'], ['appling: generate', 'appling'], ['appling: release', 'appling']]);
        expect(combined.inputs).toEqual([RELEASE_INPUT]);
    });
});

describe('variables and launches', () => {
    const context: VariableContext = {
        workspaceFolder: '/work/shop', folders: { crm: '/work/crm' }, env: { HOME: '/home/me', SHELL: '/bin/bash' },
        userHome: '/home/me', platform: 'linux', inputs: { name: 'Ada' }, config: { 'editor.tabSize': 4 }
    };

    test('resolves VS Code variables and reports the ones it cannot', () => {
        const problems: string[] = [];
        expect(resolveVariables('${workspaceFolder}|${workspaceFolderBasename}|${env:HOME}|${env:NOPE}|${userHome}${/}x|${workspaceFolder:crm}|${input:name}|${config:editor.tabSize}', context, problems))
            .toBe('/work/shop|shop|/home/me||/home/me/x|/work/crm|Ada|4');
        expect(resolveVariables('${file}${input:other}${file}', context, problems)).toBe('');
        expect(problems).toEqual(['${file}', '${input:other}']);
        expect(resolveVariables('${pathSeparator}', { ...context, platform: 'win32' })).toBe('\\');
    });

    test('a shell task runs one quoted command line through the shell, a process task its program', () => {
        const [build, watch, , , npm, ask] = parseTasksJson(TASKS, 'linux').tasks;
        expect(taskLaunch(build, context)).toEqual({
            command: '/bin/bash', args: ['-c', `make all 'with space' 'it'\\''s'`], cwd: '/work/shop/src',
            env: { GLOBAL: '1', SHARED: 'task', PLATFORM: 'linux' }, line: `make all 'with space' 'it'\\''s'`
        });
        expect(taskLaunch(watch, context)).toMatchObject({ command: 'tsc', args: ['-w'], cwd: '/work/shop' });
        expect(taskLaunch(npm, { ...context, env: {} })).toMatchObject({ command: '/bin/sh', args: ['-c', 'npm run dev'] });
        const windows = parseTasksJson(TASKS, 'win32').tasks[0];
        expect(taskLaunch(windows, { ...context, platform: 'win32', env: { ComSpec: 'C:\\Windows\\cmd.exe' } }).args).toEqual(['/d', '/c', 'nmake all "with space" "it\'s"']);
        expect(taskLaunch({ ...build, shell: { executable: 'pwsh', args: ['-NoProfile', '-Command'] } }, context).args).toEqual(['-NoProfile', '-Command', `make all "with space" 'it''s'`]);
        expect(inputsUsed(ask)).toEqual(['name', 'env']);
        expect(() => taskLaunch(parseTasksJson(TASKS, 'linux').tasks[3], context)).toThrow('no command');
    });

    test('quotes arguments for each shell', () => {
        expect(quote('plain-arg', undefined, 'posix')).toBe('plain-arg');
        expect(quote('', undefined, 'posix')).toBe(`''`);
        expect(quote('a $b', 'weak', 'posix')).toBe('"a \\$b"');
        expect(quote('a b', 'escape', 'posix')).toBe('a\\ b');
        expect(quote('a&b', 'escape', 'cmd')).toBe('a^&b');
        expect(quote('a "b"', 'strong', 'cmd')).toBe('"a ""b"""');
        expect(quote('$x', 'weak', 'powershell')).toBe('"`$x"');
    });
});

describe('dependencies', () => {
    const task = (label: string, dependsOn: string[] = [], dependsOrder: 'parallel' | 'sequence' = 'parallel') => ({ label, dependsOn, dependsOrder });

    test('builds the tree and finds unknown tasks and cycles', () => {
        const tasks = [task('all', ['a', 'b'], 'sequence'), task('a', ['c']), task('b', ['c']), task('c')];
        expect(dependencyPlan('all', tasks)).toEqual({
            label: 'all', order: 'sequence', deps: [
                { label: 'a', order: 'parallel', deps: [{ label: 'c', order: 'parallel', deps: [] }] },
                { label: 'b', order: 'parallel', deps: [{ label: 'c', order: 'parallel', deps: [] }] }
            ]
        });
        expect(planLabels(dependencyPlan('all', tasks))).toEqual(['c', 'a', 'b', 'all']);
        expect(() => dependencyPlan('x', tasks)).toThrow('There is no task "x".');
        expect(() => dependencyPlan('a', [task('a', ['missing'])])).toThrow('"a" depends on "missing", which does not exist');
        expect(() => dependencyPlan('a', [task('a', ['b']), task('b', ['c']), task('c', ['a'])])).toThrow('cycle: a → b → c → a');
    });

    test('runs a sequence one after the other, parallel ones at once, a shared dependency once', async () => {
        const log: string[] = [];
        const gates = new Map<string, () => void>();
        const run = (label: string) => new Promise<{ ok: true }>(done => {
            log.push(`start ${label}`);
            gates.set(label, () => {
                log.push(`end ${label}`);
                done({ ok: true });
            });
        });
        const plan = dependencyPlan('all', [task('all', ['a', 'b'], 'sequence'), task('a', ['p', 'q']), task('b', ['p']), task('p'), task('q')]);
        const result = executePlan(plan, run);
        const tick = () => new Promise(done => setTimeout(done, 0));
        await tick();
        expect(log).toEqual(['start p', 'start q']);
        gates.get('q')!();
        gates.get('p')!();
        await tick();
        expect(log).toEqual(['start p', 'start q', 'end q', 'end p', 'start a']);
        gates.get('a')!();
        await tick();
        // b's dependency p already ran in this plan, so b starts right away
        expect(log.slice(-2)).toEqual(['end a', 'start b']);
        gates.get('b')!();
        await tick();
        gates.get('all')!();
        expect(await result).toEqual({ ok: true });
        expect(log.filter(l => l === 'start p')).toHaveLength(1);
    });

    test('a failed dependency keeps its dependents from running', async () => {
        const ran: string[] = [];
        const skipped: [string, string][] = [];
        const plan = dependencyPlan('all', [task('all', ['a', 'b'], 'sequence'), task('a', ['bad']), task('b'), task('bad')]);
        const result = await executePlan(plan, async label => {
            ran.push(label);
            return label === 'bad' ? { ok: false, reason: '"bad" exited with code 2' } : { ok: true };
        }, (label, reason) => skipped.push([label, reason]));
        expect(ran).toEqual(['bad']);
        expect(skipped).toEqual([['a', 'A dependency failed: "bad" exited with code 2'], ['all', 'A dependency failed: "bad" exited with code 2']]);
        expect(result).toEqual({ ok: false, reason: 'A dependency failed: "bad" exited with code 2' });
    });
});

describe('task states', () => {
    test('run, exit, stop and background readiness', () => {
        const waiting = transition(IDLE, { type: 'wait' }, 1);
        expect(waiting).toEqual({ status: 'waiting', background: false, started: 1 });
        const running = transition(waiting, { type: 'start', terminal: 't1', background: false, ready: false }, 2);
        expect(running).toEqual({ status: 'running', background: false, started: 1, terminal: 't1' });
        expect(transition(running, { type: 'exit', code: 0 }, 3)).toEqual({ status: 'succeeded', background: false, started: 1, terminal: 't1', exit: { code: 0 }, ended: 3 });
        expect(transition(running, { type: 'exit', code: 2 }, 3)).toMatchObject({ status: 'failed', reason: 'exited with code 2' });
        expect(transition(running, { type: 'exit', code: 1, signal: 15 }, 3)).toMatchObject({ status: 'failed', reason: 'ended by signal 15' });
        const stopped = transition(running, { type: 'stop' }, 4);
        expect(stopped).toMatchObject({ status: 'stopped', ended: 4 });
        // the exit after a stop does not turn it into a failure
        expect(transition(stopped, { type: 'exit', code: 143 })).toBe(stopped);
        expect(transition(running, { type: 'lost' })).toMatchObject({ status: 'stopped', reason: 'its terminal is gone' });

        const watcher = transition(IDLE, { type: 'start', terminal: 't2', background: true, ready: false }, 5);
        expect(settled(watcher)).toBe(false);
        const ready = transition(watcher, { type: 'end' });
        expect(ready).toMatchObject({ status: 'running', ready: true });
        expect(settled(ready)).toBe(true);
        expect(transition(ready, { type: 'begin' })).toMatchObject({ status: 'running', ready: false });
        expect(transition(running, { type: 'end' })).toBe(running);
        expect(transition(transition(IDLE, { type: 'wait' }, 1), { type: 'done' }, 2)).toEqual({ status: 'succeeded', background: false, started: 1, ended: 2 });
        expect(transition(IDLE, { type: 'fail', reason: 'nope' }, 2)).toMatchObject({ status: 'failed', reason: 'nope' });
    });

    test('background patterns match whole lines without escape sequences, also in a scrollback', () => {
        const matcher = new BackgroundMatcher({ activeAtBeginning: true, begins: ['^\\[watch\\] build started'], ends: ['^\\[watch\\] build finished'] });
        expect(matcher.feed('\x1b[32m[watch] build st')).toEqual([]);
        expect(matcher.feed('arted\x1b[0m\r\nsome output\n[watch] build finished, watching\n')).toEqual(['begin', 'end']);
        expect(matcher.readyIn('[watch] build started\n[watch] build finished\n[watch] build started\n')).toBe(false);
        expect(matcher.readyIn('\x1b]633;A\x07[watch] build finished\r\n')).toBe(true);
        expect(matcher.readyIn('nothing here')).toBeUndefined();
        expect(stripEscapes('\x1b[1;31mred\x1b[0m \x1b]0;title\x07x')).toBe('red x');
        const tsc = new BackgroundMatcher({ activeAtBeginning: true, ...KNOWN_BACKGROUND['$tsc-watch'] });
        expect(tsc.feed('[12:00:01 PM] Starting compilation in watch mode...\n[12:00:03 PM] Found 0 errors. Watching for file changes.\n')).toEqual(['begin', 'end']);
    });

    test('feed the rail per repo and summed per workspace', () => {
        const states = new Map<string, Record<string, TaskState>>([
            ['/a', { dev: { status: 'running', background: true, ready: true }, build: { status: 'failed', background: false, reason: 'exited with code 1' }, lint: { status: 'succeeded', background: false } }],
            ['/b', { test: { status: 'waiting', background: false } }],
            ['/c', { done: { status: 'stopped', background: false } }]
        ]);
        const contributions = taskContributions(states);
        expect([...contributions.keys()]).toEqual(['/a', '/b']);
        expect(contributions.get('/a')).toEqual({
            counts: { tasksRunning: 1, tasksFailed: 1 },
            notes: ['Task running: dev (ready)', 'Task failed: build, exited with code 1']
        });
        const rail = new RailStatus();
        rail.source('tasks').replace(contributions);
        expect(rail.sum(['/a', '/b', '/c'])).toMatchObject({ tasksRunning: 2, tasksFailed: 1 });
    });

    test('the store keeps only what fits', () => {
        expect(readTaskStore({ repos: { '/a': { automatic: 'allow', tasks: { x: { status: 'running', background: true, ready: false, terminal: 't' }, y: { status: 'bogus' } } }, '/b': 3 } })).toEqual({
            repos: { '/a': { automatic: 'allow', tasks: { x: { status: 'running', background: true, ready: false, terminal: 't' } } } }
        });
        expect(readTaskStore(undefined)).toEqual({ repos: {} });
    });
});

test('the built in tasks use the repo\'s own appling, else the one of Desktop', () => {
    const own = applingCli('/r', { platform: 'linux', exists: path => path === '/r/node_modules/.bin/appling', node: '/app/electron', cli: '/app/cli.js' });
    expect(own).toEqual({ command: '/r/node_modules/.bin/appling', args: [], env: {} });
    const shipped = applingCli('/r', { platform: 'linux', exists: () => false, node: '/app/electron', cli: '/app/cli.js' });
    expect(shipped).toEqual({ command: '/app/electron', args: ['/app/cli.js'], env: { ELECTRON_RUN_AS_NODE: '1' } });
    const release = builtinTasks(shipped).tasks.find(t => t.label === 'appling: release')!;
    expect(release).toMatchObject({ type: 'process', command: '/app/electron', args: ['/app/cli.js', 'release', '${input:appling.releaseVersion}'] });
    expect(inputsUsed(release)).toEqual(['appling.releaseVersion']);
});

describe.skipIf(process.platform === 'win32')('task runner against a pty host', { timeout: 30000 }, () => {
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

    function setup() {
        const host = temp('pty-');
        hosts.push(host);
        const repo = temp('repo-');
        const data = temp('data-');
        const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: repo, SHELL: '/bin/sh', GREETING: 'hello' };
        const make = (asked: string[][] = [], answer: 'allow' | 'deny' | undefined = 'allow') => {
            const service = new TerminalService({
                host: { dir: host }, registryFile: join(data, 'terminals.json'),
                settings: () => DEFAULT_TERMINAL_SETTINGS, env, version: 'test'
            });
            const runner = new TaskRunner(service, {
                storeFile: join(data, 'tasks.json'), platform: 'linux', env, userHome: repo, killAfter: 1000,
                cli: () => ({ command: process.execPath, args: [join(import.meta.dirname, '../../cli/out/main.js')], env: {} }),
                askAutomatic: async (_, labels) => {
                    asked.push(labels);
                    return answer;
                }
            });
            return { service, runner };
        };
        return { repo, data, make };
    }

    function writeTasks(repo: string, tasks: unknown[]): void {
        mkdirSync(join(repo, '.vscode'), { recursive: true });
        writeFileSync(join(repo, '.vscode', 'tasks.json'), JSON.stringify({ version: '2.0.0', tasks }));
    }

    test('runs shell and process tasks in their own terminals, with dependencies, and reads the exit code', async () => {
        const { repo, make } = setup();
        mkdirSync(join(repo, 'sub'));
        writeTasks(repo, [
            { label: 'greet', type: 'shell', command: 'echo "$GREETING $WHO from $(pwd)" > out.txt', options: { cwd: '${workspaceFolder}/sub', env: { WHO: '${env:GREETING}-world' } } },
            { label: 'fail', type: 'process', command: '/bin/sh', args: ['-c', 'exit 3'] },
            { label: 'both', dependsOn: ['greet', 'fail'], dependsOrder: 'sequence' }
        ]);
        const { service, runner } = make();
        await runner.openRepo(repo);
        const greet = await runner.run(repo, 'greet');
        expect(greet).toMatchObject({ status: 'succeeded', exit: { code: 0 } });
        expect(readFileSync(join(repo, 'sub', 'out.txt'), 'utf8').trim()).toBe(`hello hello-world from ${join(repo, 'sub')}`);
        expect(service.state(greet.terminal!)).toMatchObject({ name: 'Task - greet', command: true, exit: { code: 0 } });

        const both = await runner.run(repo, 'both');
        expect(both).toMatchObject({ status: 'failed', reason: 'A dependency failed: "fail" exited with code 3' });
        expect(runner.state(repo, 'fail')).toMatchObject({ status: 'failed', exit: { code: 3 } });
        // the second run of greet replaced the terminal of the first one: one terminal per task
        expect(service.registry.terminals(repo)).toHaveLength(2);
        expect(service.state(greet.terminal!)).toBeUndefined();
        expect(taskContributions(runner.states()).get(repo)?.counts).toEqual({ tasksRunning: 0, tasksFailed: 2 });
        service.dispose();
    });

    test('runs the built in appling check', async () => {
        const { repo, make } = setup();
        writeFileSync(join(repo, 'shop.appling'), 'module shop {\n  entity Order {\n    total: Int\n  }\n}\n');
        const { service, runner } = make();
        const labels = runner.list(repo).map(item => item.label);
        expect(labels).toEqual(['appling: check', 'appling: generate', 'appling: release']);
        expect(runner.list(repo)[2].inputs).toEqual([RELEASE_INPUT]);
        await expect(runner.run(repo, 'appling: release')).rejects.toThrow('needs The version to release');
        expect(await runner.run(repo, 'appling: check')).toMatchObject({ status: 'succeeded' });
        writeFileSync(join(repo, 'shop.appling'), 'module shop {\n  entity Order {\n    total: Nope\n  }\n}\n');
        expect(await runner.run(repo, 'appling: check')).toMatchObject({ status: 'failed', exit: { code: 1 } });
        service.dispose();
    });

    test('a background task is running until ready, outlives the app and is found again with its state', async () => {
        const { repo, data, make } = setup();
        const script = 'echo "[watch] build started"; sleep 0.3; echo "[watch] build finished"; while true; do read line; echo "[watch] build started"; sleep 0.2; echo "[watch] build finished"; done';
        writeTasks(repo, [
            { label: 'watch', type: 'shell', command: script, isBackground: true, problemMatcher: '$esbuild-watch', runOptions: { runOn: 'folderOpen' } },
            { label: 'after', type: 'shell', command: 'echo after', dependsOn: 'watch' }
        ]);
        const asked: string[][] = [];
        const first = make(asked);
        await first.runner.openRepo(repo);
        expect(asked).toEqual([['watch']]);
        // started automatically: running, not ready yet
        await until(() => first.runner.state(repo, 'watch').status === 'running');
        expect(first.runner.state(repo, 'watch').ready).toBe(false);
        expect(taskContributions(first.runner.states()).get(repo)?.counts).toEqual({ tasksRunning: 1, tasksFailed: 0 });
        await until(() => first.runner.state(repo, 'watch').ready);
        // a dependent waits for a watcher that runs already, without starting it again
        const watchTerminal = first.runner.state(repo, 'watch').terminal!;
        expect(await first.runner.run(repo, 'after')).toMatchObject({ status: 'succeeded' });
        expect(first.runner.state(repo, 'watch')).toMatchObject({ status: 'running', terminal: watchTerminal });
        // a new round makes it busy until it ends again
        first.service.write(watchTerminal, '\r');
        await until(() => first.runner.state(repo, 'watch').ready === false);
        first.service.dispose();
        expect(JSON.parse(readFileSync(join(data, 'tasks.json'), 'utf8')).repos[repo]).toMatchObject({ automatic: 'allow', tasks: { watch: { status: 'running', terminal: watchTerminal } } });

        // the round ends while the app is closed; the next start is not asked again, does not start it twice and reads
        // that it is ready again from the scrollback
        await new Promise(done => setTimeout(done, 600));
        const second = make(asked);
        await second.runner.openRepo(repo);
        expect(asked).toHaveLength(1);
        expect(second.runner.state(repo, 'watch')).toMatchObject({ status: 'running', terminal: watchTerminal, ready: true });
        expect(second.service.registry.terminals(repo)).toContain(watchTerminal);
        await expect(second.runner.run(repo, 'watch')).rejects.toThrow('running already');

        // stop keeps the terminal with its output; restart replaces it
        await second.runner.stop(repo, 'watch');
        expect(second.runner.state(repo, 'watch').status).toBe('stopped');
        await until(() => second.service.state(watchTerminal)?.exit);
        expect(second.runner.state(repo, 'watch').status).toBe('stopped');
        void second.runner.restart(repo, 'watch');
        await until(() => second.runner.state(repo, 'watch').ready);
        const restarted = second.runner.state(repo, 'watch').terminal!;
        expect(restarted).not.toBe(watchTerminal);
        expect(second.service.state(watchTerminal)).toBeUndefined();
        await second.runner.stop(repo, 'watch');
        second.service.dispose();
    });

    test('a folder whose automatic tasks were denied does not run them', async () => {
        const { repo, make } = setup();
        writeTasks(repo, [{ label: 'auto', type: 'shell', command: 'echo hi', runOptions: { runOn: 'folderOpen' } }]);
        const asked: string[][] = [];
        const { service, runner } = make(asked, 'deny');
        await runner.openRepo(repo);
        expect(asked).toEqual([['auto']]);
        expect(runner.automatic(repo)).toBe('deny');
        expect(runner.state(repo, 'auto').status).toBe('idle');
        service.dispose();
    });
});

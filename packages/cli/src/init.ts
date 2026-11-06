import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { cancel, intro, isCancel, multiselect, outro, select, text } from '@clack/prompts';
import { findApplingFiles } from '@appling/model';

/** Referenced from node_modules, never copied, so updating @appling/ai updates what every agent reads. */
const RULES = 'node_modules/@appling/ai/rules/appling.md';
const SKILLS = 'node_modules/@appling/ai/skills';
const SERVER = { command: 'npx', args: ['appling-mcp', '.'] };
const READ_RULES = `This application is modeled in Appling. Read ${RULES} and follow it before any work.`;

export const AGENTS = {
    claude: {
        label: 'Claude Code', skills: '.claude/skills', setup(dir: string) {
            updateJson(join(dir, '.mcp.json'), c => { c.mcpServers = { ...c.mcpServers, appling: SERVER }; });
            updateJson(join(dir, '.claude/settings.json'), c => { c.enabledMcpjsonServers = union(c.enabledMcpjsonServers, 'appling'); });
            appendOnce(join(dir, 'CLAUDE.md'), `@${RULES}`);
        }
    },
    codex: {
        label: 'Codex', skills: '.agents/skills', setup(dir: string) {
            appendOnce(join(dir, '.codex/config.toml'), '[mcp_servers.appling]\ncommand = "npx"\nargs = ["appling-mcp", "."]');
            appendOnce(join(dir, 'AGENTS.md'), READ_RULES);
        }
    },
    opencode: {
        label: 'OpenCode', skills: '.agents/skills', setup(dir: string) {
            updateJson(join(dir, 'opencode.json'), c => {
                c.$schema ??= 'https://opencode.ai/config.json';
                c.mcp = { ...c.mcp, appling: { type: 'local', command: [SERVER.command, ...SERVER.args], enabled: true } };
                c.instructions = union(c.instructions, RULES);
            });
        }
    },
    gemini: {
        label: 'Gemini CLI', skills: '.agents/skills', setup(dir: string) {
            updateJson(join(dir, '.gemini/settings.json'), c => { c.mcpServers = { ...c.mcpServers, appling: SERVER }; });
            appendOnce(join(dir, 'GEMINI.md'), `@./${RULES}`);
        }
    },
    antigravity: {
        label: 'Antigravity CLI', skills: '.agents/skills', setup(dir: string) {
            updateJson(join(dir, '.agents/mcp_config.json'), c => { c.mcpServers = { ...c.mcpServers, appling: SERVER }; });
            appendOnce(join(dir, 'AGENTS.md'), READ_RULES);
        }
    }
};

export const STACKS = {
    django: '@appling/codegen-django',
    ash: '@appling/codegen-ash',
    go: '@appling/codegen-go',
    rust: '@appling/codegen-rust'
};

export type Agent = keyof typeof AGENTS;
export type Stack = keyof typeof STACKS;
export interface InitOptions { name: string; agents: Agent[]; stack?: Stack }

const NAME = /^[a-z][a-z0-9_-]*$/;
const NAME_HINT = 'lower case letters, digits, "-" and "_", starting with a letter';

/** appling init [folder] [--name <name>] [--agents <a,b>] [--stack <stack|none>]: asks for what the flags leave open. */
export async function init(args: string[]): Promise<number> {
    let flags;
    try {
        flags = parseArgs({ args, allowPositionals: true, options: { name: { type: 'string' }, agents: { type: 'string' }, stack: { type: 'string' } } });
    } catch (error) {
        console.error((error as Error).message);
        return 2;
    }
    const dir = resolve(flags.positionals[0] ?? '.');
    const given = {
        name: flags.values.name,
        agents: flags.values.agents?.split(',').map(a => a.trim()),
        stack: flags.values.stack
    };
    const invalid = [
        given.name !== undefined && !NAME.test(given.name) && `--name: use ${NAME_HINT}`,
        given.agents?.some(a => !(a in AGENTS)) && `--agents: choose from ${Object.keys(AGENTS).join(', ')}`,
        given.stack !== undefined && given.stack !== 'none' && !(given.stack in STACKS) && `--stack: choose from ${Object.keys(STACKS).join(', ')}, none`
    ].filter(Boolean);
    if (invalid.length) {
        invalid.forEach(line => console.error(line));
        return 2;
    }
    const complete = given.name !== undefined && given.agents !== undefined && given.stack !== undefined;
    if (!complete && !process.stdin.isTTY) {
        console.error('Not interactive: pass --name, --agents and --stack.');
        return 2;
    }
    const options = complete
        ? { name: given.name!, agents: given.agents as Agent[], stack: given.stack === 'none' ? undefined : given.stack as Stack }
        : await ask(dir, given);
    if (!options) return 1;

    mkdirSync(dir, { recursive: true });
    if (!existsSync(join(dir, 'package.json'))) writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: options.name, private: true }, null, 2) + '\n');
    const packages = ['@appling/cli', '@appling/ai', ...(options.stack ? [STACKS[options.stack]] : [])];
    const manager = packageManager(dir);
    const install = spawnSync(manager, [...(manager === 'npm' ? ['install', '--save-dev'] : ['add', '-D']), ...packages],
        { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' });
    if (install.status !== 0) {
        console.error(`Installing ${packages.join(' ')} with ${manager} failed.`);
        return 1;
    }
    scaffold(dir, options);
    console.log(`Appling is set up for ${options.agents.map(a => AGENTS[a].label).join(', ')}. Start your agent in ${relative(process.cwd(), dir) || 'this folder'} and describe the application you want.`);
    return 0;
}

/** Writes the model, the generate target and each agent's wiring. Safe to run again: existing settings are kept. */
export function scaffold(dir: string, { name, agents, stack }: InitOptions): void {
    const module = name.replace(/-/g, '_');
    if (stack) {
        updateJson(join(dir, 'appling.config.json'), c => {
            c.generate ??= [];
            if (!c.generate.some((t: { extension: string }) => t.extension === STACKS[stack])) c.generate.push({ extension: STACKS[stack], out: `build/${module}` });
        });
    }
    if (!findApplingFiles(dir).length) {
        mkdirSync(join(dir, 'models'), { recursive: true });
        writeFileSync(join(dir, 'models', `${module}.appling`), `module ${module} {\n}\n`);
    }
    const skills = readdirSync(join(dir, SKILLS));
    for (const agent of agents) {
        AGENTS[agent].setup(dir);
        for (const skill of skills) link(join(dir, AGENTS[agent].skills, skill), join(dir, SKILLS, skill));
    }
}

async function ask(dir: string, given: { name?: string; agents?: string[]; stack?: string }): Promise<InitOptions | undefined> {
    intro('appling init');
    const name = given.name ?? await text({
        message: 'Project name',
        initialValue: NAME.test(basename(dir)) ? basename(dir) : '',
        validate: value => NAME.test(value ?? '') ? undefined : `Use ${NAME_HINT}.`
    });
    if (isCancel(name)) return stop();
    const agents = given.agents ?? await multiselect({
        message: 'Coding agents to connect',
        options: Object.entries(AGENTS).map(([value, agent]) => ({ value, label: agent.label })),
        required: true
    });
    if (isCancel(agents)) return stop();
    const stack = given.stack ?? await select({
        message: 'Stack to generate the application with',
        options: [...Object.keys(STACKS).map(value => ({ value, label: value[0].toUpperCase() + value.slice(1) })), { value: 'none', label: 'Decide later' }]
    });
    if (isCancel(stack)) return stop();
    outro('Installing');
    return { name, agents: agents as Agent[], stack: stack === 'none' ? undefined : stack as Stack };
}

function stop(): undefined {
    cancel('Cancelled.');
    return undefined;
}

/** The project's lockfile decides, then the package manager that ran init (npx, pnpm dlx, yarn dlx, bunx), else npm. */
function packageManager(dir: string): string {
    const locks: [string, string][] = [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun'], ['package-lock.json', 'npm']];
    const lock = locks.find(([file]) => existsSync(join(dir, file)));
    if (lock) return lock[1];
    const runner = process.env.npm_config_user_agent?.split('/')[0];
    return runner && ['pnpm', 'yarn', 'bun'].includes(runner) ? runner : 'npm';
}

function updateJson(path: string, change: (json: any) => void): void {
    const json = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
    change(json);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(json, null, 2) + '\n');
}

/** Appends the text unless the file already has its first line. */
function appendOnce(path: string, text: string): void {
    const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
    if (current.includes(text.split('\n')[0])) return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, current ? `${current.trimEnd()}\n\n${text}\n` : `${text}\n`);
}

function union(list: string[] | undefined, item: string): string[] {
    return [...new Set([...(list ?? []), item])];
}

/** A relative link, so the project can move; a junction on Windows, which needs no privileges. */
function link(path: string, target: string): void {
    try {
        lstatSync(path);
        return;
    } catch {
        mkdirSync(dirname(path), { recursive: true });
        symlinkSync(relative(dirname(path), target), path, 'junction');
    }
}

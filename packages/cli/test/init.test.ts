import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { scaffold, type InitOptions } from '../src/init.js';

/** A project folder with an installed @appling/ai that ships two skills. */
function project(): string {
    const dir = mkdtempSync(join(tmpdir(), 'appling-init-'));
    for (const skill of ['appling', 'appling-registry']) {
        mkdirSync(join(dir, 'node_modules/@appling/ai/skills', skill), { recursive: true });
        writeFileSync(join(dir, 'node_modules/@appling/ai/skills', skill, 'SKILL.md'), `name: ${skill}`);
    }
    return dir;
}

const read = (dir: string, file: string) => readFileSync(join(dir, file), 'utf8');
const json = (dir: string, file: string) => JSON.parse(read(dir, file));

describe('scaffold', () => {
    test('writes the starter model and the generate target', () => {
        const dir = project();
        scaffold(dir, { name: 'todo-app', agents: [], stack: 'ash' });
        expect(read(dir, 'models/todo_app.appling')).toBe('module todo_app {\n}\n');
        expect(json(dir, 'appling.config.json')).toEqual({ generate: [{ extension: '@appling/codegen-ash', out: 'build/todo_app' }] });
    });

    test('wires every agent to the MCP server, the rules and the skills in node_modules', () => {
        const dir = project();
        scaffold(dir, { name: 'todo', agents: ['claude', 'codex', 'opencode', 'gemini', 'antigravity'] });
        const server = { command: 'npx', args: ['appling-mcp', '.'] };
        expect(json(dir, '.mcp.json').mcpServers.appling).toEqual(server);
        expect(json(dir, '.claude/settings.json').enabledMcpjsonServers).toEqual(['appling']);
        expect(read(dir, 'CLAUDE.md')).toBe('@node_modules/@appling/ai/rules/appling.md\n');
        expect(read(dir, '.codex/config.toml')).toContain('[mcp_servers.appling]\ncommand = "npx"\nargs = ["appling-mcp", "."]');
        expect(json(dir, 'opencode.json')).toMatchObject({
            mcp: { appling: { type: 'local', command: ['npx', 'appling-mcp', '.'] } },
            instructions: ['node_modules/@appling/ai/rules/appling.md']
        });
        expect(json(dir, '.gemini/settings.json').mcpServers.appling).toEqual(server);
        expect(read(dir, 'GEMINI.md')).toBe('@./node_modules/@appling/ai/rules/appling.md\n');
        expect(json(dir, '.agents/mcp_config.json').mcpServers.appling).toEqual(server);
        expect(read(dir, 'AGENTS.md').match(/rules\/appling\.md/g)).toHaveLength(1);
        for (const skills of ['.claude/skills', '.agents/skills']) {
            expect(readlinkSync(join(dir, skills, 'appling'))).toBe('../../node_modules/@appling/ai/skills/appling');
            expect(realpathSync(join(dir, skills, 'appling-registry'))).toBe(realpathSync(join(dir, 'node_modules/@appling/ai/skills/appling-registry')));
        }
    });

    test('keeps existing settings and changes nothing when run again', () => {
        const dir = project();
        writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
        writeFileSync(join(dir, 'CLAUDE.md'), '# Notes\n');
        mkdirSync(join(dir, 'src'));
        writeFileSync(join(dir, 'src/shop.appling'), 'module shop {\n}\n');
        const options: InitOptions = { name: 'shop', agents: ['claude', 'codex'], stack: 'django' };
        const files = () => ['.mcp.json', 'CLAUDE.md', '.codex/config.toml', 'AGENTS.md', 'appling.config.json'].map(f => read(dir, f));
        scaffold(dir, options);
        const first = files();
        scaffold(dir, options);
        expect(files()).toEqual(first);
        expect(Object.keys(json(dir, '.mcp.json').mcpServers)).toEqual(['other', 'appling']);
        expect(read(dir, 'CLAUDE.md')).toBe('# Notes\n\n@node_modules/@appling/ai/rules/appling.md\n');
        expect(() => read(dir, 'models/shop.appling')).toThrow();
    });
});

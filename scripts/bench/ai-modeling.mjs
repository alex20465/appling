// Measures whether an assistant that knows only the language reference (docs/language, what the MCP tool
// `language_reference` serves) writes valid Appling models from a business brief. Each brief in
// scripts/bench/briefs/ goes to a fresh `claude -p` session without tools, the answer's ```appling block is checked
// with the built CLI, and the run is scored by its errors and the element kinds it uses.
// Usage: node scripts/bench/ai-modeling.mjs [--model sonnet] [--runs 1] [--brief <name>] [--keep]   (build the CLI first)
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
    model: { type: 'string', default: 'sonnet' }, runs: { type: 'string', default: '1' }, brief: { type: 'string' }, keep: { type: 'boolean', default: false }
} });
const root = new URL('../../', import.meta.url).pathname;
const cli = join(root, 'packages/cli/out/main.js');
const pages = readdirSync(join(root, 'docs/language')).filter(f => f.endsWith('.md')).sort();
const reference = pages.map(f => readFileSync(join(root, 'docs/language', f), 'utf8')).join('\n\n');
const briefs = readdirSync(join(root, 'scripts/bench/briefs')).filter(f => f.endsWith('.md') && (!values.brief || f === `${values.brief}.md`));

const work = mkdtempSync(join(tmpdir(), 'appling-ai-bench-'));
const system = join(work, 'system.md');
writeFileSync(system, `You write models in Appling, a language for the business logic of an application. Its whole reference follows. Answer with one complete model in a single \`\`\`appling code block (one or more module blocks) and nothing else.\n\n${reference}`);
console.log(`reference: ${pages.length} pages, ${reference.length} characters (about ${Math.round(reference.length / 4)} tokens); model ${values.model}\n`);
console.log('| brief | run | errors | kinds | lines |\n|---|---|---|---|---|');

let valid = 0, total = 0;
for (const file of briefs) {
    for (let run = 1; run <= Number(values.runs); run++) {
        const dir = mkdtempSync(join(work, `${file.slice(0, -3)}-`));
        const answer = execFileSync('claude', ['-p', '--model', values.model, '--system-prompt-file', system, '--tools', '', '--strict-mcp-config',
            '--setting-sources', '', '--no-session-persistence', '--output-format', 'text'],
            { cwd: dir, input: readFileSync(join(root, 'scripts/bench/briefs', file), 'utf8'), encoding: 'utf8', maxBuffer: 1 << 24 });
        const model = answer.match(/```appling\n([\s\S]*?)```/)?.[1] ?? '';
        writeFileSync(join(dir, 'model.appling'), model);
        const check = spawnSync(process.execPath, [cli, 'check', dir], { encoding: 'utf8' });
        const errors = Number(check.stdout.match(/(\d+) error\(s\)/)?.[1] ?? 1);
        const graph = errors ? undefined : JSON.parse(execFileSync(process.execPath, [cli, 'graph', dir], { encoding: 'utf8', maxBuffer: 1 << 24 }));
        const kinds = graph ? new Set(graph.nodes.map(n => n.kind)).size : '';
        console.log(`| ${file.slice(0, -3)} | ${run} | ${model ? errors : 'no model'} | ${kinds} | ${model.split('\n').length - 1} |`);
        total++;
        if (model && !errors) valid++;
    }
}
console.log(`\n${valid} of ${total} runs wrote a valid model.${values.keep ? ` Answers in ${work}` : ''}`);
if (!values.keep) rmSync(work, { recursive: true, force: true });

// Codegen coverage: plans every installed extension (packages/codegen-*) over the all-constructs fixture and the
// examples, and reports per extension the share of generated, partial and todo elements, the completion and the
// registry tasks, with a breakdown per node kind. Build the packages first.
//
// Usage: node scripts/ci/codegen-coverage.mjs [--root <checkout>] [--json <file>] [--markdown <file>] [--base <json>] [--badge <file>] [--note <text>]
//   --root      the checkout whose language, fixture, examples and extensions are planned (default: this one), so CI
//               can measure the base branch with this script
//   --json      writes the report as JSON
//   --markdown  writes the report as Markdown (default: stdout), with the change against --base when given
//   --base      a JSON report of an earlier run (the base branch) to compare with
//   --badge     writes a shields.io endpoint JSON with the headline figure
//   --note      a line added at the end of the Markdown
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const here = resolve(import.meta.dirname, '../..');
const { values } = parseArgs({ options: {
    root: { type: 'string', default: here },
    json: { type: 'string' }, markdown: { type: 'string' }, base: { type: 'string' }, badge: { type: 'string' }, note: { type: 'string' }
} });
const root = resolve(values.root);
const load = (checkout, path) => import(pathToFileURL(join(checkout, 'packages', path)).href);

// The report and its formatting come from this checkout, the planning from the measured one.
const { coverageBadge, coverageMarkdown, coverageReport } = await load(here, 'codegen/out/index.js');
const { buildSources, errorsOf } = await load(root, 'lang/out/index.js');
const { buildGraph } = await load(root, 'model/out/index.js');
const { plan } = await load(root, 'codegen/out/index.js');

const INPUTS = [
    { input: 'constructs', dir: 'packages/lang/test/fixtures/constructs', name: 'shop' },
    { input: 'examples', dir: 'examples', name: 'examples' }
];

const extensions = readdirSync(join(root, 'packages')).filter(d => d.startsWith('codegen-')).sort();
const graphs = [];
for (const { input, dir, name } of INPUTS) {
    const folder = join(root, dir);
    const sources = Object.fromEntries(readdirSync(folder).filter(f => f.endsWith('.appling') && !f.startsWith('.'))
        .map(f => [pathToFileURL(join(folder, f)).href, readFileSync(join(folder, f), 'utf8')]));
    const workspace = await buildSources(sources);
    const errors = errorsOf(workspace);
    if (errors.length) throw new Error(`${dir} has errors:\n${errors.join('\n')}`);
    graphs.push({ input, name, graph: buildGraph(workspace.documents.map(d => d.parseResult.value), workspace.services) });
}

const plans = [];
for (const dir of extensions) {
    const entry = join(root, 'packages', dir, 'out/index.js');
    if (!existsSync(entry)) throw new Error(`packages/${dir} is not built`);
    const extension = (await import(pathToFileURL(entry).href)).default;
    for (const { input, name, graph } of graphs) plans.push({ extension: extension.name, input, entries: plan(graph, extension, name).entries });
}

const report = coverageReport(plans);
const base = values.base && existsSync(values.base) ? JSON.parse(readFileSync(values.base, 'utf8')) : undefined;
const markdown = coverageMarkdown(report, base, { note: values.note ?? '' });
if (values.json) writeFileSync(values.json, `${JSON.stringify(report, null, 2)}\n`);
if (values.badge) writeFileSync(values.badge, `${JSON.stringify(coverageBadge(report))}\n`);
if (values.markdown) writeFileSync(values.markdown, markdown);
else process.stdout.write(markdown);

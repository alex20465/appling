import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { Model } from '@appling/lang';
import { buildGraph, fingerprint, type Graph } from '@appling/model';
import { buildWorkspace } from '../../lang/test/workspace.js';
import { addedRuns, generateElements, locateWritten, mainRun, readGenerations, readRegistry, workspaceImplementation, workspaceReferences, type CodegenExtension, type GenerationEvent } from '../src/index.js';

/** A header line that every step rewrites, so the code each step adds moves down; one class per entity, fields inside. */
const classes: CodegenExtension = {
    name: 'classes',
    setup: () => [{ kind: 'template', file: 'README', write: () => 'generated\n' }],
    steps(node, context) {
        if (node.kind === 'Entity') {
            const fields = context.children(node.qn).map(f => `    ${f.qn.split('.').pop()}: ${f.props.type}`);
            return [{
                kind: 'template', file: 'models.py',
                write: existing => {
                    const body = (existing ?? '').split('\n').slice(1).join('\n');
                    const count = (body.match(/^class /gm)?.length ?? 0) + 1;
                    return `# ${count} classes\n${body}${body && !body.endsWith('\n') ? '\n' : ''}class ${node.qn.split('.').pop()}:\n${fields.join('\n')}\n`;
                }
            }];
        }
        if (node.kind === 'Action') return [{ kind: 'task', what: `implement ${node.qn}` }];
        return [];
    }
};

const print = (graph: Graph, qn: string) => fingerprint(graph.nodes.find(n => n.qn === qn)!);

async function graphOf(model: string) {
    const { documents, services } = await buildWorkspace({ 'm.appling': model });
    return buildGraph(documents.map(d => d.parseResult.value as Model), services);
}

const MODEL = 'module m {\n  entity A {\n    a: Int\n  }\n\n  entity B {\n    b: Int\n  }\n\n  action Close on A {\n  }\n}\n';

function workspace(): string {
    const root = mkdtempSync(join(tmpdir(), 'appling-generate-'));
    writeFileSync(join(root, 'appling.config.json'), JSON.stringify({ generate: [{ extension: 'classes', out: 'out' }] }));
    return root;
}

test('the lines a step added are found again after later steps moved them', () => {
    expect(addedRuns('h\nx\n', 'H\nx\nclass A:\n    a: Int\n')).toEqual([['H'], ['class A:', '    a: Int']]);
    expect(mainRun(addedRuns('h\nx\n', 'H\nx\nclass A:\n    a: Int\n'))).toEqual(['class A:', '    a: Int']);
    expect(addedRuns(undefined, 'a\nb')).toEqual([['a', 'b']]);
    expect(addedRuns('same', 'same')).toEqual([]);
});

test('a first generation creates the project, marks the code it wrote for each element and records the fingerprints', async () => {
    const root = workspace();
    const graph = await graphOf(MODEL);
    const events: GenerationEvent[] = [];
    const result = await generateElements({ root, graph, selection: { mode: 'outstanding' }, load: async () => classes, onEvent: e => events.push(e) });

    expect(result.failed).toBe(false);
    expect(events.map(e => e.type)).toEqual(['start', 'planned', ...events.filter(e => e.type === 'log').map(() => 'log'), 'generated', 'tasks', 'done']);
    expect(events.find(e => e.type === 'tasks')).toMatchObject({ tasks: [{ qn: 'm.Close', missing: ['implement m.Close'] }] });
    expect(readFileSync(join(root, 'out/models.py'), 'utf8')).toBe(`# 2 classes\n# @appling m.A ${print(graph, 'm.A')}\nclass A:\n    a: Int\n# @appling m.B ${print(graph, 'm.B')}\nclass B:\n    b: Int\n`);
    expect(events.find(e => e.type === 'generated')).toMatchObject({ references: 2 });
    expect((await workspaceReferences(root, graph)).map(r => [r.qn, r.file, r.start, r.end, r.status])).toEqual([
        ['m.A', 'out/models.py', 3, 4, 'current'],
        ['m.B', 'out/models.py', 6, 7, 'current']
    ]);
    expect(Object.keys(readGenerations(root).out.fingerprints)).toContain('m.A.a');

    const { states, tasks, targets } = await workspaceImplementation(root, graph);
    expect(states['m.A'].state).toBe('implemented');
    // covered by its entity's code and unchanged since the generation
    expect(states['m.A.a'].state).toBe('implemented');
    expect(states['m.Close'].state).toBe('unimplemented');
    expect(tasks).toMatchObject([{ target: 'out', qn: 'm.Close', missing: ['implement m.Close'], attempts: 0 }]);
    expect(targets).toMatchObject([{ extension: 'classes', out: 'out', generated: true }]);

    // a task an agent finished stays listed as done; elements without tasks are none
    const registry = readRegistry(join(root, 'out'))!;
    registry.entries['m.Close'] = { ...registry.entries['m.Close'], status: 'done', missing: [] };
    writeFileSync(join(root, 'out/.appling/tasks.json'), JSON.stringify(registry));
    expect((await workspaceImplementation(root, graph)).tasks).toMatchObject([{ qn: 'm.Close', status: 'done' }]);
});

test('a changed element is unimplemented at once; generating it merges only its files and keeps the rest', async () => {
    const root = workspace();
    await generateElements({ root, graph: await graphOf(MODEL), selection: { mode: 'all' }, load: async () => classes });
    writeFileSync(join(root, 'out/README'), 'generated, then edited\n');

    const changed = await graphOf(MODEL.replace('b: Int', 'b: Int\n    c: Text'));
    const before = (await workspaceImplementation(root, changed)).states;
    expect(before['m.B.c']).toMatchObject({ state: 'unimplemented', outstanding: true });
    // its entity has a current reference, so it stays implemented while its new field waits
    expect(before['m.B']).toMatchObject({ state: 'implemented', outstanding: false });

    const events: GenerationEvent[] = [];
    await generateElements({ root, graph: changed, selection: { mode: 'outstanding' }, load: async () => classes, onEvent: e => events.push(e) });
    expect(events.find(e => e.type === 'planned')).toMatchObject({ mode: 'sync' });
    expect((events.find(e => e.type === 'planned') as { elements: string[] }).elements).toEqual(expect.arrayContaining(['m.B.c', 'm.A', 'm.B']));
    expect(events.find(e => e.type === 'merged')).toMatchObject({ report: { updated: ['models.py'] } });
    expect(readFileSync(join(root, 'out/models.py'), 'utf8')).toContain('    c: Text');
    expect(readFileSync(join(root, 'out/README'), 'utf8')).toBe('generated, then edited\n');
    const after = (await workspaceImplementation(root, changed)).states;
    expect(after['m.B.c']).toMatchObject({ state: 'implemented', outstanding: false });

    const again: GenerationEvent[] = [];
    await generateElements({ root, graph: changed, selection: { mode: 'outstanding' }, load: async () => classes, onEvent: e => again.push(e) });
    expect(again.find(e => e.type === 'skipped')).toMatchObject({ reason: 'Nothing changed since the last generation.' });
});

test('a registry task makes an element partial, so does a stale marker, and markers outside the project survive generation', async () => {
    const root = workspace();
    const graph = await graphOf(MODEL);
    await generateElements({ root, graph, selection: { mode: 'all' }, load: async () => classes });
    const registry = readRegistry(join(root, 'out'))!;
    registry.entries['m.A'] = { ...registry.entries['m.A'], status: 'partial', missing: [{ what: 'validate a', context: { props: {}, related: [] } }] };
    writeFileSync(join(root, 'out/.appling/tasks.json'), JSON.stringify(registry));
    writeFileSync(join(root, 'other.py'), '# @appling m.Close\ndef close():\n    pass\n\n# @appling m.B 00000000\ndef old():\n    pass\n');

    const states = (await workspaceImplementation(root, graph)).states;
    expect(states['m.A'].state).toBe('partial');
    // written against another version of m.B
    expect(states['m.B'].state).toBe('partial');
    // linked by hand (brownfield): implemented, but its task is still open
    expect(states['m.Close'].state).toBe('partial');

    await generateElements({ root, graph, selection: { mode: 'elements', elements: ['m.B'] }, load: async () => classes });
    const references = await workspaceReferences(root, graph);
    expect(references.filter(r => r.qn === 'm.Close')).toHaveLength(1);
    expect(references.filter(r => r.qn === 'm.B').map(r => r.file)).toEqual(['other.py', 'out/models.py']);
});

test('a project that is not empty and has no registry is refused', async () => {
    const root = workspace();
    writeFileSync(join(root, 'out'), '');
    const events: GenerationEvent[] = [];
    const result = await generateElements({ root, graph: await graphOf(MODEL), selection: { mode: 'all' }, load: async () => classes, onEvent: e => events.push(e) });
    expect(result.failed).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'done', failed: true });
});

test('written code is located by its lines; a created file covers its lines', () => {
    const out = mkdtempSync(join(tmpdir(), 'appling-written-'));
    writeFileSync(join(out, 'a.txt'), 'top\nclass A:\n    a\n');
    writeFileSync(join(out, 'b.txt'), '\n\nall of b\n');
    expect(locateWritten(out, [
        { node: 'm.A', file: 'a.txt', lines: ['class A:', '    a'] },
        { node: 'm.A', file: 'a.txt', lines: ['class A:', '    a'] },
        { node: 'm.Gone', file: 'a.txt', lines: ['class Gone:'] },
        { node: 'm', file: 'b.txt' }
    ])).toEqual({ 'm.A': [{ file: 'a.txt', start: 2, end: 3 }], m: [{ file: 'b.txt', start: 3, end: 3 }] });
});

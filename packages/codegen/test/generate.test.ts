import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { Model } from '@appling/lang';
import { buildGraph, readReferences } from '@appling/model';
import { buildWorkspace } from '../../lang/test/workspace.js';
import { addedRuns, generateElements, locateWritten, mainRun, readGenerations, readRegistry, workspaceImplementation, type CodegenExtension, type GenerationEvent } from '../src/index.js';

/** A header line that every step rewrites, so the code each step adds moves down; one class per entity, fields inside. */
const classes: CodegenExtension = {
    name: 'classes',
    setup: () => [{ kind: 'template', file: 'README', write: () => 'generated\n' }],
    steps(node, context) {
        if (node.kind === 'Entity') {
            const fields = context.children(node.qn).map(f => `    ${f.qn.split('.').pop()}: ${f.props.type}`);
            return [{
                kind: 'template', file: 'models.txt',
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

test('a first generation creates the project, records the code references of what it wrote and the fingerprints', async () => {
    const root = workspace();
    const graph = await graphOf(MODEL);
    const events: GenerationEvent[] = [];
    const result = await generateElements({ root, graph, selection: { mode: 'outstanding' }, load: async () => classes, onEvent: e => events.push(e) });

    expect(result.failed).toBe(false);
    expect(events.map(e => e.type)).toEqual(['start', 'planned', ...events.filter(e => e.type === 'log').map(() => 'log'), 'generated', 'tasks', 'done']);
    expect(events.find(e => e.type === 'tasks')).toMatchObject({ tasks: [{ qn: 'm.Close', missing: ['implement m.Close'] }] });
    expect(readFileSync(join(root, 'out/models.txt'), 'utf8')).toBe('# 2 classes\nclass A:\n    a: Int\nclass B:\n    b: Int\n');
    const references = readReferences(root);
    expect(references['m.A']).toEqual([{ file: 'out/models.txt', start: 2, end: 3, anchor: 'class A:' }]);
    expect(references['m.B']).toEqual([{ file: 'out/models.txt', start: 4, end: 5, anchor: 'class B:' }]);
    expect(references['(project)']).toBeUndefined();
    expect(Object.keys(readGenerations(root).out.fingerprints)).toContain('m.A.a');

    const { states, tasks, targets } = workspaceImplementation(root, graph);
    expect(states['m.A'].state).toBe('implemented');
    // covered by its entity's code and unchanged since the generation
    expect(states['m.A.a'].state).toBe('implemented');
    expect(states['m.Close'].state).toBe('unimplemented');
    expect(tasks).toMatchObject([{ target: 'out', qn: 'm.Close', missing: ['implement m.Close'], attempts: 0 }]);
    expect(targets).toMatchObject([{ extension: 'classes', out: 'out', generated: true }]);
});

test('a changed element is unimplemented at once; generating it merges only its files and keeps the rest', async () => {
    const root = workspace();
    await generateElements({ root, graph: await graphOf(MODEL), selection: { mode: 'all' }, load: async () => classes });
    writeFileSync(join(root, 'out/README'), 'generated, then edited\n');

    const changed = await graphOf(MODEL.replace('b: Int', 'b: Int\n    c: Text'));
    const before = workspaceImplementation(root, changed).states;
    expect(before['m.B.c']).toMatchObject({ state: 'unimplemented', outstanding: true });
    // its entity has a current reference, so it stays implemented while its new field waits
    expect(before['m.B']).toMatchObject({ state: 'implemented', outstanding: false });

    const events: GenerationEvent[] = [];
    await generateElements({ root, graph: changed, selection: { mode: 'outstanding' }, load: async () => classes, onEvent: e => events.push(e) });
    expect(events.find(e => e.type === 'planned')).toMatchObject({ mode: 'sync' });
    expect((events.find(e => e.type === 'planned') as { elements: string[] }).elements).toEqual(expect.arrayContaining(['m.B.c', 'm.A', 'm.B']));
    expect(events.find(e => e.type === 'merged')).toMatchObject({ report: { updated: ['models.txt'] } });
    expect(readFileSync(join(root, 'out/models.txt'), 'utf8')).toContain('    c: Text');
    expect(readFileSync(join(root, 'out/README'), 'utf8')).toBe('generated, then edited\n');
    const after = workspaceImplementation(root, changed).states;
    expect(after['m.B.c']).toMatchObject({ state: 'implemented', outstanding: false });

    const again: GenerationEvent[] = [];
    await generateElements({ root, graph: changed, selection: { mode: 'outstanding' }, load: async () => classes, onEvent: e => again.push(e) });
    expect(again.find(e => e.type === 'skipped')).toMatchObject({ reason: 'Nothing changed since the last generation.' });
});

test('a registry task makes an element partial, a broken reference shows, and references outside the project survive generation', async () => {
    const root = workspace();
    const graph = await graphOf(MODEL);
    await generateElements({ root, graph, selection: { mode: 'all' }, load: async () => classes });
    const registry = readRegistry(join(root, 'out'))!;
    registry.entries['m.A'] = { ...registry.entries['m.A'], status: 'partial', missing: [{ what: 'validate a', context: { props: {}, related: [] } }] };
    writeFileSync(join(root, 'out/.appling/tasks.json'), JSON.stringify(registry));
    writeFileSync(join(root, 'other.py'), 'def close():\n    pass\n');
    const references = JSON.parse(readFileSync(join(root, '.appling/references.json'), 'utf8'));
    references['m.Close'] = [{ file: 'other.py', start: 1, end: 2, anchor: 'def close():' }];
    references['m.B'].push({ file: 'other.py', start: 1, end: 1, anchor: 'def gone():' });
    writeFileSync(join(root, '.appling/references.json'), JSON.stringify(references));

    const states = workspaceImplementation(root, graph).states;
    expect(states['m.A'].state).toBe('partial');
    expect(states['m.B'].state).toBe('broken');
    // linked by hand (brownfield): implemented, but its task is still open
    expect(states['m.Close'].state).toBe('partial');

    await generateElements({ root, graph, selection: { mode: 'elements', elements: ['m.B'] }, load: async () => classes });
    expect(readReferences(root)['m.Close']).toHaveLength(1);
    expect(readReferences(root)['m.B'].map(r => r.file)).toEqual(['other.py', 'out/models.txt']);
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

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { fingerprint, markerFolders, recordReferences, resolveReferences, type Graph, type GraphNode } from '../src/index.js';

const node = (qn: string, kind = 'Entity', props: Record<string, unknown> = {}, data: Record<string, unknown> = {}) => ({ qn, kind, layer: 'domain', level: 1, module: 'sales', props, data }) as unknown as GraphNode;
const graph: Graph = {
    nodes: [node('sales.Order'), node('sales.Purchase'), node('sales.since_v1', 'Migration', {}, { steps: [{ $type: 'RenameStep', target: 'Cart', newName: 'Purchase' }] })],
    edges: []
};
const MODELS = 'from django.db import models\n\n\nclass Order(models.Model):\n    total = models.DecimalField()\n';

/** A git work tree with the model folder and the application next to it. */
function workspace(): string {
    const top = mkdtempSync(join(tmpdir(), 'appling-'));
    for (const dir of ['.git', 'models', 'app']) mkdirSync(join(top, dir));
    writeFileSync(join(top, 'app/models.py'), MODELS);
    return join(top, 'models');
}

test('markers are searched in the git work tree around the workspace and the given folders', () => {
    const root = workspace();
    expect(markerFolders(root, ['../build'])).toEqual([join(root, '..'), join(root, '../build')]);
});

test('recording writes the marker with the fingerprint, moves it, and an empty list removes it', async () => {
    const root = workspace();
    const print = fingerprint(graph.nodes[0]);
    expect(await recordReferences(root, graph, 'sales.Order', [{ file: join(root, '../app/models.py'), line: 4 }]))
        .toEqual([{ file: '../app/models.py', start: 5, end: 6, line: 4, fingerprint: print }]);
    expect(readFileSync(join(root, '../app/models.py'), 'utf8')).toBe(MODELS.replace('class Order', `# @appling sales.Order ${print}\nclass Order`));
    // recorded again on its field: the marker of the class goes
    expect(await recordReferences(root, graph, 'sales.Order', [{ file: '../app/models.py', line: 6 }])).toMatchObject([{ start: 6, end: 6, line: 5 }]);
    expect(readFileSync(join(root, '../app/models.py'), 'utf8')).toBe(MODELS.replace('    total', `    # @appling sales.Order ${print}\n    total`));
    await recordReferences(root, graph, 'sales.Order', []);
    expect(readFileSync(join(root, '../app/models.py'), 'utf8')).toBe(MODELS);
    await expect(recordReferences(root, graph, 'sales.Gone', [])).rejects.toThrow('No element or sub-anchor sales.Gone.');
    await expect(recordReferences(root, graph, 'sales.Order', [{ file: '../app/gone.py', line: 1 }])).rejects.toThrow('No file ../app/gone.py.');
    await expect(recordReferences(root, graph, 'sales.Order', [{ file: '../app/models.py', line: 2 }])).rejects.toThrow('Line 2 of models.py is empty');
});

test('a reference is current with the fingerprint of its element, stale when it changed or was renamed, orphaned without element', async () => {
    const root = workspace();
    const code = [
        `# @appling sales.Order ${fingerprint(graph.nodes[0])}`, 'class Order: pass',
        '# @appling sales.Order 00000000', 'class Old: pass',
        '# @appling sales.Cart', 'class Cart: pass',
        '# @appling sales.Gone', 'class Gone: pass',
        ''
    ].join('\n');
    writeFileSync(join(root, '../app/models.py'), code);
    expect((await resolveReferences(root, graph)).map(r => [r.qn, r.status, r.marked])).toEqual([
        ['sales.Order', 'current', undefined],
        ['sales.Order', 'stale', undefined],
        ['sales.Purchase', 'stale', 'sales.Cart'],
        ['sales.Gone', 'orphaned', undefined]
    ]);
    // a line added above moves nothing that matters
    writeFileSync(join(root, '../app/models.py'), `import os\n${code}`);
    expect((await resolveReferences(root, graph))[0]).toMatchObject({ qn: 'sales.Order', status: 'current', line: 2, start: 3, end: 3 });
});

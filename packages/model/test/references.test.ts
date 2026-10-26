import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { readReferences, recordReferences, resolveReferences, type Graph } from '../src/index.js';

const MODELS = 'from django.db import models\n\n\nclass Order(models.Model):\n    total = models.DecimalField()\n';

function workspace(): string {
    const root = mkdtempSync(join(tmpdir(), 'appling-'));
    mkdirSync(join(root, 'models'));
    mkdirSync(join(root, 'app'));
    writeFileSync(join(root, 'app/models.py'), MODELS);
    return join(root, 'models');
}

test('references are recorded relative to the workspace with their first line as the anchor', () => {
    const root = workspace();
    expect(recordReferences(root, 'sales.Order', [{ file: join(root, '../app/models.py'), start: 4, end: 5 }]))
        .toEqual([{ file: '../app/models.py', start: 4, end: 5, anchor: 'class Order(models.Model):' }]);
    expect(readReferences(root)['sales.Order']).toHaveLength(1);
    expect(() => recordReferences(root, 'sales.Order', [{ file: '../app/models.py', start: 2, end: 3 }])).toThrow('Line 2 of ../app/models.py is empty');
    expect(() => recordReferences(root, 'sales.Order', [{ file: '../app/models.py', start: 4, end: 40 }])).toThrow('Lines 4-40 are outside');
    expect(() => recordReferences(root, 'sales.Order', [{ file: '../app/gone.py', start: 1, end: 1 }])).toThrow('No file ../app/gone.py.');
    recordReferences(root, 'sales.Order', []);
    expect(readReferences(root)).toEqual({});
});

test('resolving follows the anchor and reports shifted, broken and orphaned references', () => {
    const root = workspace();
    recordReferences(root, 'sales.Order', [{ file: '../app/models.py', start: 4, end: 5 }]);
    recordReferences(root, 'sales.Gone', [{ file: '../app/models.py', start: 1, end: 1 }]);
    const graph = { nodes: [{ qn: 'sales.Order' }], edges: [] } as unknown as Graph;
    expect(resolveReferences(root, graph).map(r => [r.qn, r.status])).toEqual([['sales.Order', 'current'], ['sales.Gone', 'orphaned']]);

    writeFileSync(join(root, '../app/models.py'), `# header\n${MODELS}`);
    expect(resolveReferences(root)[0]).toMatchObject({ status: 'shifted', start: 5, end: 6, recorded: { start: 4, end: 5 } });

    writeFileSync(join(root, '../app/models.py'), MODELS.replace('Order', 'Purchase'));
    expect(resolveReferences(root)[0].status).toBe('broken');
});

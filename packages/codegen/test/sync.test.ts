import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { Model } from '@appling/lang';
import { buildGraph } from '@appling/model';
import { buildWorkspace } from '../../lang/test/workspace.js';
import { mergeGeneration, plan, readRegistry, runPlan, writeRegistry, type CodegenExtension } from '../src/index.js';

/** One line per entity field in fields.txt, and one per entity in its own file. */
const lines: CodegenExtension = {
    name: 'lines',
    syncExclude: ['history/**'],
    steps(node) {
        if (node.kind === 'Entity') return [{ kind: 'template', file: `${node.qn}.txt`, write: () => `entity ${node.qn}\n` }];
        if (node.kind === 'Field') return [{ kind: 'template', file: 'fields.txt', write: existing => `${existing ?? 'fields\n'}${node.qn}\n` }, { kind: 'task', what: `check ${node.qn}` }];
        return [];
    }
};

async function generate(model: string, out: string) {
    const { documents, services } = await buildWorkspace({ 'm.appling': model });
    runPlan(plan(buildGraph(documents.map(d => d.parseResult.value as Model), services), lines, 'm'), out);
}

test('sync replaces untouched files, keeps and merges your changes, removes what the model dropped and keeps done work', async () => {
    const root = mkdtempSync(join(tmpdir(), 'appling-sync-'));
    const out = join(root, 'out');
    await generate('module m {\n  entity A {\n    a: Int\n    b: Int\n  }\n\n  entity Gone {\n  }\n}\n', out);
    writeFileSync(join(out, 'm.A.txt'), 'entity m.A, edited by hand\n');
    writeFileSync(join(out, 'fields.txt'), 'fields, with a note\nm.A.a\nm.A.b\n');
    const registry = readRegistry(out)!;
    registry.entries['m.A.a'] = { ...registry.entries['m.A.a'], status: 'done', missing: [] };
    writeRegistry(out, registry);

    const next = join(root, 'next');
    await generate('module m {\n  entity A {\n    a: Int\n    b: Int\n    c: Int\n  }\n\n  entity New {\n  }\n}\n', next);
    const report = mergeGeneration(out, next, lines.syncExclude!);

    expect(report).toMatchObject({ added: ['m.New.txt'], removed: ['m.Gone.txt'], merged: ['fields.txt'], conflicts: [] });
    expect(readFileSync(join(out, 'm.A.txt'), 'utf8')).toBe('entity m.A, edited by hand\n');
    expect(readFileSync(join(out, 'fields.txt'), 'utf8')).toBe('fields, with a note\nm.A.a\nm.A.b\nm.A.c\n');
    expect(existsSync(join(out, 'm.Gone.txt'))).toBe(false);
    const merged = readRegistry(out)!;
    expect(merged.entries['m.A.a'].status).toBe('done');
    expect(merged.entries['m.A.c'].status).toBe('partial');
});

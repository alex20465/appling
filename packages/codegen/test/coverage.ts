import { existsSync, readFileSync } from 'node:fs';
import { expect } from 'vitest';
import type { Model } from '@appling/lang';
import { buildGraph } from '@appling/model';
import { coverage, coverageTable, plan, type CodegenExtension, type CoverageRow } from '@appling/codegen';
import { buildWorkspace, constructs } from '../../lang/test/workspace.js';

/**
 * Plans the coverage fixture (every grammar construct) with an extension and compares the coverage per node kind
 * with the committed baseline file. A drop (fewer generated, more todo, more tasks, a kind gone) fails even under
 * `vitest -u`; any other change is a file snapshot mismatch, so `vitest run -u` raises the baseline after a gain.
 */
export async function expectCoverage(extension: CodegenExtension, baseline: string): Promise<void> {
    const { documents, services } = await buildWorkspace(constructs());
    const result = coverage(plan(buildGraph(documents.map(d => d.parseResult.value as Model), services), extension, 'shop').entries);
    const rows = [...result.kinds, result.total];
    const before = existsSync(baseline) ? JSON.parse(readFileSync(baseline, 'utf8')) as CoverageRow[] : rows;
    const drops: string[] = [];
    for (const old of before) {
        const row = rows.find(r => r.kind === old.kind);
        if (!row) { drops.push(`${old.kind} is gone`); continue; }
        if (row.generated < old.generated) drops.push(`${row.kind}: ${old.generated} -> ${row.generated} generated`);
        if (row.todo > old.todo) drops.push(`${row.kind}: ${old.todo} -> ${row.todo} todo`);
        if (row.tasks > old.tasks) drops.push(`${row.kind}: ${old.tasks} -> ${row.tasks} tasks`);
    }
    expect(drops, `coverage of ${extension.name} dropped\n${coverageTable(result)}`).toEqual([]);
    await expect(`${JSON.stringify(rows, null, 2)}\n`).toMatchFileSnapshot(baseline);
}

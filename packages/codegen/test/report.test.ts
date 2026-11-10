import { describe, expect, test } from 'vitest';
import { completion, COVERAGE_MARKER, coverageBadge, coverageMarkdown, coverageReport, formatChange, type RegistryEntry, type Status } from '../src/index.js';

function entries(kind: string, statuses: Status[], tasks = 0): RegistryEntry[] {
    return statuses.map((status, i) => ({
        qn: `m.${kind}${i}`, kind, layer: 'domain', status, steps: [], files: [],
        missing: Array.from({ length: i ? 0 : tasks }, () => ({ what: 'x', context: { props: {}, related: [] } }))
    }));
}

const head = coverageReport([
    { extension: '@appling/codegen-django', input: 'constructs', entries: [...entries('Entity', ['generated', 'partial'], 1), ...entries('Action', ['todo', 'partial'], 2)] },
    { extension: '@appling/codegen-django', input: 'examples', entries: entries('Entity', ['generated', 'done']) },
    { extension: '@appling/codegen-go', input: 'constructs', entries: entries('Entity', ['todo'], 1) },
    { extension: '@appling/codegen-go', input: 'examples', entries: [] }
]);

describe('the computation', () => {
    test('completion counts partial as half and an empty row as complete', () => {
        expect(completion({ kind: 'k', generated: 2, partial: 2, todo: 0, tasks: 0, left: 0 })).toBe(0.75);
        expect(completion({ kind: 'k', generated: 0, partial: 1, todo: 3, tasks: 9, left: 0 })).toBe(0.125);
        expect(completion({ kind: 'k', generated: 0, partial: 0, todo: 0, tasks: 0, left: 0 })).toBe(1);
    });

    test('sums every input per extension and per kind, done counting as generated', () => {
        const django = head.extensions[0];
        expect(head.inputs).toEqual(['constructs', 'examples']);
        expect(head.extensions.map(e => e.extension)).toEqual(['@appling/codegen-django', '@appling/codegen-go']);
        expect(django.kinds).toEqual([
            { kind: 'Action', generated: 0, partial: 1, todo: 1, tasks: 2, left: 0 },
            { kind: 'Entity', generated: 3, partial: 1, todo: 0, tasks: 1, left: 0 }
        ]);
        expect(django.total).toEqual({ kind: 'total', generated: 3, partial: 2, todo: 1, tasks: 3, left: 0 });
        expect(django.inputs.examples).toEqual({ kind: 'total', generated: 2, partial: 0, todo: 0, tasks: 0, left: 0 });
        expect(django.completion).toBe(4 / 6);
        expect(head.total).toEqual({ kind: 'total', generated: 3, partial: 2, todo: 2, tasks: 4, left: 0 });
        expect(head.completion).toBe(4 / 7);
    });

    test('a task left to code does not lower the coverage and counts apart', () => {
        const left = { what: 'implement a client', leftToCode: true, context: { props: {}, related: [] } };
        const gap = { what: 'check the guard', context: { props: {}, related: [] } };
        const report = coverageReport([{ extension: '@appling/codegen-go', input: 'constructs', entries: [
            { qn: 'm.Payments', kind: 'External', layer: 'application', status: 'todo', steps: [], files: [], missing: [left] },
            { qn: 'm.Flow', kind: 'Machine', layer: 'behavior', status: 'partial', steps: [], files: [], missing: [gap, left] }
        ] }]);
        expect(report.total).toEqual({ kind: 'total', generated: 1, partial: 1, todo: 0, tasks: 1, left: 2 });
        expect(report.completion).toBe(0.75);
    });

    test('the badge carries the headline figure', () => {
        expect(coverageBadge(head)).toEqual({ schemaVersion: 1, label: 'codegen coverage', message: '57%', color: 'yellow' });
    });
});

describe('the change', () => {
    test('a gain is ▲ and a drop ▼, shares in percentage points', () => {
        expect(formatChange(0.805, 0.79, { share: true })).toBe('▲ +1.5 pp');
        expect(formatChange(0.5, 0.75, { share: true })).toBe('▼ -25.0 pp');
        expect(formatChange(12, 10)).toBe('▲ +2');
    });

    test('fewer tasks is the gain', () => {
        expect(formatChange(8, 10, { lowerIsBetter: true })).toBe('▲ -2');
        expect(formatChange(11, 10, { lowerIsBetter: true })).toBe('▼ +1');
    });

    test('no change is empty, a missing value before is new', () => {
        expect(formatChange(0.5, 0.5, { share: true })).toBe('');
        expect(formatChange(0.50001, 0.5, { share: true })).toBe('');
        expect(formatChange(3, undefined)).toBe('new');
    });
});

describe('the Markdown', () => {
    test('without a base it has the marker, the headline, one line per extension and the kinds folded', () => {
        const text = coverageMarkdown(head);
        expect(text.startsWith(`${COVERAGE_MARKER}\n## Codegen coverage\n`)).toBe(true);
        expect(text).toContain('**57.1%** generated completion, 4 registry tasks and 0 left to code, over constructs and examples.');
        expect(text).toContain('| django | 50.0% | 33.3% | 16.7% | 66.7% | 3 | 0 |');
        expect(text).toContain('<summary>django: 66.7% (constructs 50.0%, examples 100.0%)</summary>');
        expect(text).toContain('| Action | 0 | 1 | 1 | 25.0% | 2 | 0 |');
        expect(text).not.toContain('Changes per kind');
    });

    test('with a base every figure shows its change, and the changed kinds are listed', () => {
        const base = coverageReport([
            { extension: '@appling/codegen-django', input: 'constructs', entries: [...entries('Entity', ['generated', 'todo'], 2), ...entries('Action', ['todo', 'partial'], 2)] },
            { extension: '@appling/codegen-django', input: 'examples', entries: entries('Entity', ['generated', 'done']) },
            { extension: '@appling/codegen-rust', input: 'constructs', entries: entries('Entity', ['generated']) }
        ]);
        const text = coverageMarkdown(head, base);
        expect(text).toContain('**57.1%** generated completion ▼ -7.1 pp, 4 registry tasks and 0 left to code, over');
        expect(text).toContain('| django | 50.0% | 33.3% | 16.7% | 66.7% | ▲ +8.3 pp | 3 | ▲ -1 | 0 |');
        expect(text).toContain('| go | 0.0% | 0.0% | 100.0% | 0.0% | new | 1 | new | 0 |');
        expect(text).toContain('| rust | | | | gone | | |');
        expect(text).toContain('| django | Entity | 3 | 1 (0) | 0 (1) | 87.5% | ▲ +12.5 pp | 1 | ▲ -1 |');
        expect(text).not.toContain('| django | Action |');
        expect(text).toContain('| Action | 0 | 1 | 1 | 25.0% |  | 2 |  | 0 |');
    });

    test('an unchanged report says so', () => {
        expect(coverageMarkdown(head, head)).toContain('No node kind changed.');
    });
});

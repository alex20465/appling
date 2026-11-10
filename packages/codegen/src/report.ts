import { coverage, type CoverageRow, type RegistryEntry } from './plan.js';

/** The registry entries of one extension's plan over one input (a set of `.appling` files). */
export interface PlannedInput {
    extension: string;
    input: string;
    entries: RegistryEntry[];
}

/** One extension's coverage, summed over every input it planned. */
export interface ExtensionCoverage {
    extension: string;
    /** The total per input, by input name. */
    inputs: Record<string, CoverageRow>;
    /** One row per node kind over all inputs, sorted by kind. */
    kinds: CoverageRow[];
    total: CoverageRow;
    /** `completion(total)`, the headline figure of the extension. */
    completion: number;
}

/** The coverage of several extensions over several inputs: what the CI report and `appling generate --coverage` print. */
export interface CoverageReport {
    inputs: string[];
    extensions: ExtensionCoverage[];
    /** Every extension and input together; `completion` is the headline figure of the badge. */
    total: CoverageRow;
    completion: number;
}

/** Marks the sticky PR comment that holds the report, so a later run updates it instead of adding one. */
export const COVERAGE_MARKER = '<!-- appling-codegen-coverage -->';

/**
 * The generated completion share of a row, between 0 and 1: `(generated + partial / 2) / (generated + partial + todo)`.
 * A partial element has code with open registry tasks, so it counts as half; a row without elements is complete.
 */
export function completion(row: CoverageRow): number {
    const all = row.generated + row.partial + row.todo;
    return all ? (row.generated + row.partial / 2) / all : 1;
}

function sum(kind: string, rows: CoverageRow[]): CoverageRow {
    return rows.reduce((total, r) => ({
        kind, generated: total.generated + r.generated, partial: total.partial + r.partial, todo: total.todo + r.todo, tasks: total.tasks + r.tasks,
        left: total.left + (r.left ?? 0)
    }), { kind, generated: 0, partial: 0, todo: 0, tasks: 0, left: 0 });
}

/** Sums the plans per extension (in the order they come) and per node kind. */
export function coverageReport(plans: PlannedInput[]): CoverageReport {
    const inputs = [...new Set(plans.map(p => p.input))];
    const extensions = [...Map.groupBy(plans, p => p.extension)].map(([extension, of]): ExtensionCoverage => {
        const kinds = coverage(of.flatMap(p => p.entries)).kinds;
        const total = sum('total', kinds);
        return {
            extension,
            inputs: Object.fromEntries(of.map(p => [p.input, coverage(p.entries).total])),
            kinds,
            total,
            completion: completion(total)
        };
    });
    const total = sum('total', extensions.map(e => e.total));
    return { inputs, extensions, total, completion: completion(total) };
}

const percent = (share: number) => `${(share * 100).toFixed(1)}%`;

/**
 * The change from `before` to `now`: `▲` for a gain, `▼` for a drop, empty when nothing changed and `new` without a
 * value before. Shares (0 to 1) print in percentage points, counts as numbers. With `lowerIsBetter` (registry tasks)
 * a smaller value is the gain, so `▲ -2` reads "two tasks fewer".
 */
export function formatChange(now: number, before: number | undefined, { share = false, lowerIsBetter = false } = {}): string {
    if (before === undefined) return 'new';
    const delta = share ? Math.round((now - before) * 1000) / 10 : now - before;
    if (!delta) return '';
    const value = `${delta > 0 ? '+' : '-'}${share ? `${Math.abs(delta).toFixed(1)} pp` : Math.abs(delta)}`;
    return `${(delta > 0) !== lowerIsBetter ? '▲' : '▼'} ${value}`;
}

/** The short name of an extension package: `@appling/codegen-django` becomes `django`. */
export function extensionLabel(name: string): string {
    return name.replace(/^@appling\/codegen-/, '');
}

const share = (row: CoverageRow, of: keyof Pick<CoverageRow, 'generated' | 'partial' | 'todo'>) => {
    const all = row.generated + row.partial + row.todo;
    return percent(all ? row[of] / all : 0);
};

function changed(now: CoverageRow, before: CoverageRow | undefined): boolean {
    return !before || (['generated', 'partial', 'todo', 'tasks'] as const).some(k => now[k] !== before[k]);
}

/**
 * The report as Markdown, for the job summary and the PR comment: the headline figure, one line per extension with
 * the shares, the completion and the registry tasks, then the node kinds whose figures changed and the full breakdown
 * per kind in a folded section per extension. With a `base` report every figure shows its change (`formatChange`).
 * The first line is `COVERAGE_MARKER` unless `marker` is false.
 */
export function coverageMarkdown(report: CoverageReport, base?: CoverageReport, { title = 'Codegen coverage', note = '', marker = true } = {}): string {
    const change = (now: number, before: number | undefined, options?: { share?: boolean, lowerIsBetter?: boolean }) =>
        base ? ` ${formatChange(now, before, options)}`.trimEnd() : '';
    const head = base ? ' | Δ' : '';
    const lines = [
        ...marker ? [COVERAGE_MARKER] : [],
        `## ${title}`,
        '',
        `**${percent(report.completion)}** generated completion${change(report.completion, base && completion(base.total), { share: true })}, ${report.total.tasks} registry tasks${change(report.total.tasks, base?.total.tasks, { lowerIsBetter: true })} and ${report.total.left} left to code, over ${report.inputs.join(' and ')}.`,
        '',
        `| extension | generated | partial | todo | completion${head} | tasks${head} | left to code |`,
        `|---|---|---|---|---|${base ? '---|' : ''}---|${base ? '---|' : ''}---|`
    ];
    const cells = (now: number, before: number | undefined, text: string, options: { share?: boolean, lowerIsBetter?: boolean }) =>
        base ? `${text} | ${formatChange(now, before, options)}` : text;
    for (const e of report.extensions) {
        const old = base?.extensions.find(b => b.extension === e.extension);
        lines.push(`| ${extensionLabel(e.extension)} | ${share(e.total, 'generated')} | ${share(e.total, 'partial')} | ${share(e.total, 'todo')} | ${cells(e.completion, old && completion(old.total), percent(e.completion), { share: true })} | ${cells(e.total.tasks, old?.total.tasks, String(e.total.tasks), { lowerIsBetter: true })} | ${e.total.left} |`);
    }
    for (const gone of base?.extensions.filter(b => !report.extensions.some(e => e.extension === b.extension)) ?? []) {
        lines.push(`| ${extensionLabel(gone.extension)} | | | | gone | | |`);
    }
    if (base) {
        const moves = report.extensions.flatMap(e => {
            const old = base.extensions.find(b => b.extension === e.extension);
            const kinds = e.kinds.filter(k => changed(k, old?.kinds.find(o => o.kind === k.kind))).map(k => ({ e, k, before: old?.kinds.find(o => o.kind === k.kind) }));
            const gone = (old?.kinds ?? []).filter(o => !e.kinds.some(k => k.kind === o.kind)).map(o => ({ e, k: { ...o, generated: 0, partial: 0, todo: 0, tasks: 0, left: 0 }, before: o }));
            return [...kinds, ...gone];
        });
        lines.push('', '### Changes per kind', '');
        if (!moves.length) lines.push('No node kind changed.');
        else {
            lines.push('| extension | kind | generated | partial | todo | completion | Δ | tasks | Δ |', '|---|---|---|---|---|---|---|---|---|');
            for (const { e, k, before } of moves) {
                const counts = (key: 'generated' | 'partial' | 'todo') => `${k[key]}${before && before[key] !== k[key] ? ` (${before[key]})` : ''}`;
                lines.push(`| ${extensionLabel(e.extension)} | ${k.kind} | ${counts('generated')} | ${counts('partial')} | ${counts('todo')} | ${percent(completion(k))} | ${formatChange(completion(k), before && completion(before), { share: true })} | ${k.tasks} | ${formatChange(k.tasks, before?.tasks, { lowerIsBetter: true })} |`);
            }
        }
    }
    lines.push('', '### Per node kind', '');
    for (const e of report.extensions) {
        const old = base?.extensions.find(b => b.extension === e.extension);
        const inputs = Object.entries(e.inputs).map(([input, row]) => `${input} ${percent(completion(row))}`).join(', ');
        lines.push('<details>', `<summary>${extensionLabel(e.extension)}: ${percent(e.completion)} (${inputs})</summary>`, '');
        lines.push(`| kind | generated | partial | todo | completion${head} | tasks${head} | left to code |`, `|---|---|---|---|---|${base ? '---|' : ''}---|${base ? '---|' : ''}---|`);
        for (const k of e.kinds) {
            const before = old?.kinds.find(o => o.kind === k.kind);
            lines.push(`| ${k.kind} | ${k.generated} | ${k.partial} | ${k.todo} | ${cells(completion(k), before && completion(before), percent(completion(k)), { share: true })} | ${cells(k.tasks, before?.tasks, String(k.tasks), { lowerIsBetter: true })} | ${k.left} |`);
        }
        lines.push('', '</details>', '');
    }
    lines.push('Completion = (generated + partial / 2) / elements: a partial element has code and open registry tasks, so it counts as half. Tasks are generator gaps; work the model leaves to the code by design (`docs/concept.md` section 8) counts in left to code and does not lower the completion.');
    if (note) lines.push('', note);
    return `${lines.join('\n')}\n`;
}

/** A shields.io endpoint badge (https://shields.io/badges/endpoint-badge) with the headline figure. */
export function coverageBadge(report: CoverageReport): { schemaVersion: 1, label: string, message: string, color: string } {
    const value = report.completion * 100;
    const color = value >= 90 ? 'brightgreen' : value >= 75 ? 'green' : value >= 60 ? 'yellowgreen' : value >= 40 ? 'yellow' : 'orange';
    return { schemaVersion: 1, label: 'codegen coverage', message: `${Math.round(value)}%`, color };
}

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Graph } from '@appling/model';
import type { Prerequisite } from './contract.js';
import { describe, type Plan, type PlannedStep, type RegistryEntry } from './plan.js';
import { saveBaseline } from './sync.js';
import { addedRuns, mainRun, type Written } from './written.js';

export interface Registry {
    extension: string;
    /** The command that runs the generated project's tests. */
    test?: string[];
    entries: Record<string, RegistryEntry>;
}

export const REGISTRY = join('.appling', 'tasks.json');

/** Returns one message per prerequisite the model needs that is missing or has the wrong version. */
export function checkPrerequisites(prerequisites: Prerequisite[], graph?: Graph): string[] {
    return prerequisites.filter(p => !p.needed || !graph || p.needed(graph)).flatMap(p => {
        const result = spawnSync(p.command[0], p.command.slice(1), { encoding: 'utf8' });
        const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
        const ok = !result.error && result.status === 0 && (!p.expect || p.expect.test(output));
        return ok ? [] : [`${p.name}: ${p.hint}`];
    });
}

/**
 * Runs the planned steps in order into the output folder and writes the registry. Stops at the first failing command.
 * With `written`, collects what each step wrote, for the code references (`locateWritten`).
 */
export function runPlan(plan: Plan, out: string, log: (line: string) => void = () => { }, written?: Written[]): Registry {
    const root = resolve(out);
    runSteps(plan.steps, out, log, written);
    const registry: Registry = { extension: plan.extension, test: plan.test, entries: Object.fromEntries(plan.entries.map(e => [e.qn, e])) };
    writeRegistry(root, registry);
    saveBaseline(root, plan.syncExclude ?? []);
    return registry;
}

export function runSteps(steps: PlannedStep[], out: string, log: (line: string) => void = () => { }, written?: Written[]): void {
    const root = resolve(out);
    for (const { node, step } of steps) {
        log(`${node}: ${describe(step)}`);
        if (step.kind === 'command') {
            const cwd = resolve(root, step.cwd ?? '.');
            mkdirSync(cwd, { recursive: true });
            const result = spawnSync(step.run[0], step.run.slice(1), { cwd, encoding: 'utf8', input: step.input, env: step.env && { ...process.env, ...step.env } });
            if (result.error || result.status !== 0) throw new Error(commandFailure(step.run, result));
            for (const file of step.creates ?? []) written?.push({ node, file });
        } else if (step.kind === 'template') {
            const file = join(root, step.file);
            mkdirSync(dirname(file), { recursive: true });
            const before = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
            const after = step.write(before);
            writeFileSync(file, after);
            const lines = written && mainRun(addedRuns(before, after));
            if (lines) written!.push({ node, file: step.file, lines });
        }
    }
}

/** The reason a command failed, with the end of what it printed on stdout and stderr (tools such as mix report errors on stdout). */
function commandFailure(run: string[], result: SpawnSyncReturns<string>): string {
    const reason = result.error?.message ?? (result.signal ? `killed by ${result.signal}` : `exit ${result.status}`);
    const output = [result.stdout, result.stderr].map(o => (o ?? '').trimEnd()).filter(Boolean).join('\n').split('\n').slice(-60).join('\n');
    return `${run.join(' ')} failed (${reason})${output ? `:\n${output}` : ''}`;
}

export function readRegistry(out: string): Registry | undefined {
    const file = join(resolve(out), REGISTRY);
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Registry : undefined;
}

export function writeRegistry(out: string, registry: Registry): void {
    mkdirSync(join(resolve(out), '.appling'), { recursive: true });
    writeFileSync(join(resolve(out), REGISTRY), JSON.stringify(registry, null, 2) + '\n');
}

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Graph, TypeData } from '@appling/model';
import type { CodegenExtension } from './contract.js';
import { mapContext, type PlannedStep } from './plan.js';
import { readRegistry, runSteps, writeRegistry } from './run.js';

/** One Appling migration step, with where the element lives now. */
export interface MigrationChange {
    /** Stable identity: the migration's qualified name and the step's position in it. */
    id: string;
    block: string;
    module: string;
    kind: 'rename' | 'retype' | 'remove';
    /** Qualified name before the step. */
    target: string;
    /** Qualified name now, after this and the later steps of the module; undefined when removed. */
    current?: string;
    /** Qualified name of the target's parent now. */
    parent?: string;
    newName?: string;
    oldType?: TypeData;
    newType?: TypeData;
    /** One timestamp for the whole run, such as 20261023101500, for migration file names. */
    stamp: string;
}

/** Read access to the generated project, for extensions that extend existing migration history. */
export interface ProjectFiles {
    read(path: string): string | undefined;
    list(dir: string): string[];
}

export const APPLIED = join('.appling', 'migrations.json');

interface Step$ {
    $type: 'RenameStep' | 'RetypeStep' | 'RemoveStep';
    target: string;
    newName?: string;
    oldType?: TypeData;
    newType?: TypeData;
}

/** The migration steps of the model that the generated project has not applied yet, in declaration order. */
export function pendingChanges(graph: Graph, applied: string[], stamp: string): MigrationChange[] {
    const done = new Set(applied);
    return [...Map.groupBy(graph.nodes.filter(n => n.kind === 'Migration'), n => n.module)].flatMap(([module, migrations]) => {
        const steps = migrations.flatMap(m => ((m.data.steps ?? []) as Step$[]).map((step, index) => ({ step, id: `${m.qn}#${index}`, block: m.qn.slice(m.qn.lastIndexOf('.') + 1) })));
        return steps.flatMap(({ step, id, block }, i) => {
            if (done.has(id)) return [];
            const later = steps.slice(i + 1).map(s => s.step);
            const path = step.$type === 'RenameStep' ? renamed(step) : step.target;
            const current = step.$type === 'RemoveStep' ? undefined : follow(path, later);
            const parentPath = step.target.includes('.') ? step.target.slice(0, step.target.lastIndexOf('.')) : undefined;
            const parent = parentPath && follow(parentPath, steps.slice(i).map(s => s.step));
            return [{
                id, block, module, stamp,
                kind: step.$type === 'RenameStep' ? 'rename' as const : step.$type === 'RetypeStep' ? 'retype' as const : 'remove' as const,
                target: `${module}.${step.target}`,
                current: current && `${module}.${current}`,
                parent: parent ? `${module}.${parent}` : module,
                newName: step.newName, oldType: step.oldType, newType: step.newType
            }];
        });
    });
}

/** Asks the extension for the steps of every pending change; tasks go to the registry entry of the changed element. */
export function planMigrations(graph: Graph, extension: CodegenExtension, name: string, options: Record<string, unknown>, out: string, changes: MigrationChange[]): { steps: PlannedStep[], tasks: { qn: string, what: string }[] } {
    if (!extension.migrate) throw new Error(`${extension.name} does not generate migrations.`);
    const context = mapContext(graph, name, options);
    const files = projectFiles(out);
    const steps: PlannedStep[] = [];
    const tasks: { qn: string, what: string }[] = [];
    for (const change of changes) {
        const qn = change.current ?? change.target;
        for (const step of extension.migrate(change, context, files)) {
            if (step.kind === 'task') tasks.push({ qn, what: step.what });
            else if (!steps.some(s => step.kind === 'command' && s.step.kind === 'command' && s.step.run.join(' ') === step.run.join(' '))) steps.push({ node: qn, step });
        }
    }
    const phase = (s: PlannedStep) => (s.step.kind === 'task' ? 0 : s.step.phase ?? 0);
    return { steps: steps.map((s, i) => ({ s, i })).sort((a, b) => phase(a.s) - phase(b.s) || a.i - b.i).map(({ s }) => s), tasks };
}

/** Runs the migration steps, records the changes as applied and adds the open work to the registry. */
export function runMigrations(out: string, plan: { steps: PlannedStep[], tasks: { qn: string, what: string }[] }, changes: MigrationChange[], log: (line: string) => void = () => { }): void {
    runSteps(plan.steps, out, log);
    const registry = readRegistry(out);
    if (registry) {
        for (const { qn, what } of plan.tasks) {
            const entry = registry.entries[qn];
            if (!entry) continue;
            entry.missing.push({ what, context: { props: {}, related: [] } });
            entry.status = 'partial';
        }
        writeRegistry(out, registry);
    }
    const file = join(resolve(out), APPLIED);
    writeFileSync(file, JSON.stringify([...readApplied(out), ...changes.map(c => c.id)], null, 2) + '\n');
}

export function readApplied(out: string): string[] {
    const file = join(resolve(out), APPLIED);
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as string[] : [];
}

function projectFiles(out: string): ProjectFiles {
    const root = resolve(out);
    return {
        read: path => existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : undefined,
        list: dir => existsSync(join(root, dir)) ? readdirSync(join(root, dir)).sort() : []
    };
}

function renamed(step: Step$): string {
    return step.target.replace(/[^.]+$/, step.newName!);
}

function follow(path: string, steps: Step$[]): string | undefined {
    for (const step of steps) {
        if (path !== step.target && !path.startsWith(`${step.target}.`)) continue;
        if (step.$type === 'RemoveStep') return undefined;
        if (step.$type === 'RenameStep') path = renamed(step) + path.slice(step.target.length);
    }
    return path;
}

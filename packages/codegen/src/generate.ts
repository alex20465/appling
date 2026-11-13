import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
    anchorStates, fingerprint, implementationStates, outstandingElements, replaceReferencesIn, resolveReferences,
    type ElementImplementation, type GenerationRecord, type Graph
} from '@appling/model';
import { loadExtension, readConfig, type Target } from './config.js';
import type { CodegenExtension } from './contract.js';
import { pendingChanges, planMigrations, readApplied, runMigrations } from './migrate.js';
import { describe, plan, type RegistryEntry } from './plan.js';
import { checkPrerequisites, readRegistry, runPlan } from './run.js';
import { BASELINE, mergeGeneration, type SyncReport } from './sync.js';
import { locateWritten, type Written } from './written.js';

/** What each target's last generation wrote, by the target's `out` as configured: `.appling/generation.json` of the workspace. */
export const GENERATIONS = join('.appling', 'generation.json');

export function readGenerations(root: string): Record<string, GenerationRecord> {
    const file = join(root, GENERATIONS);
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Record<string, GenerationRecord> : {};
}

/** Records the fingerprints of the elements a generation wrote into a target, dropping elements the model no longer has. */
export function recordGeneration(root: string, out: string, graph: Graph, elements: Iterable<string>): GenerationRecord {
    const all = readGenerations(root);
    const nodes = new Map(graph.nodes.map(n => [n.qn, n]));
    const previous = Object.entries(all[out]?.fingerprints ?? {}).filter(([qn]) => nodes.has(qn));
    const record: GenerationRecord = { at: new Date().toISOString(), fingerprints: Object.fromEntries(previous) };
    for (const qn of elements) {
        const node = nodes.get(qn);
        if (node) record.fingerprints[qn] = fingerprint(node);
    }
    all[out] = record;
    mkdirSync(dirname(join(root, GENERATIONS)), { recursive: true });
    writeFileSync(join(root, GENERATIONS), JSON.stringify(all, null, 2) + '\n');
    return record;
}

/**
 * After a generation into a target (`out` as configured, relative to the workspace): records the code references of
 * what it wrote for these elements, replacing their earlier references into the target, and their fingerprints.
 * Returns the number of references.
 */
export function recordWritten(root: string, out: string, graph: Graph, written: Written[], elements: Set<string>): number {
    const located = locateWritten(resolve(root, out), written, elements);
    replaceReferencesIn(root, resolve(root, out), located);
    recordGeneration(root, out, graph, elements);
    return Object.values(located).reduce((sum, r) => sum + r.length, 0);
}

/** A registry entry with its target, for lists such as the IDE's registry panel. */
export interface TargetTask {
    /** The target's `out`, as configured. */
    target: string;
    qn: string;
    kind: string;
    status: RegistryEntry['status'];
    missing: string[];
    attempts: number;
    notes: string[];
}

export interface TargetState {
    extension: string;
    out: string;
    /** Whether the target has a registry, so it was generated. */
    generated: boolean;
    /** When the IDE or `generateElements` last generated into it. */
    at?: string;
}

export interface WorkspaceImplementation {
    states: Record<string, ElementImplementation>;
    /** The states of the sub-anchors (`anchorStates`), by address. */
    anchors: Record<string, ElementImplementation>;
    targets: TargetState[];
    /** Every entry of every target's registry that still has something missing. */
    tasks: TargetTask[];
}

/** The implementation state of every element of a workspace: its code references, registries and last generations. */
export function workspaceImplementation(root: string, graph: Graph): WorkspaceImplementation {
    const configured = readConfig(root).generate ?? [];
    const records = readGenerations(root);
    const registries = configured.map(t => ({ target: t, registry: readRegistry(resolve(root, t.out)) }));
    const entries = registries.flatMap(r => Object.values(r.registry?.entries ?? {}));
    const references = resolveReferences(root, graph);
    const states = implementationStates(graph, {
        references,
        tasks: entries,
        outstanding: outstandingElements(graph, configured.map(t => records[t.out]))
    });
    return {
        states,
        anchors: anchorStates(graph, references, states),
        targets: registries.map(({ target, registry }) => ({ extension: target.extension, out: target.out, generated: !!registry, at: records[target.out]?.at })),
        tasks: registries.flatMap(({ target, registry }) => Object.values(registry?.entries ?? {})
            .filter(e => e.status === 'done' || e.missing.length)
            .map(e => ({ target: target.out, qn: e.qn, kind: e.kind, status: e.status, missing: e.missing.map(m => m.what), attempts: e.attempts ?? 0, notes: e.notes ?? [] })))
    };
}

/** What to generate: the elements new or changed since the last generation, everything, or some elements with their members. */
export type GenerationSelection = { mode: 'outstanding' } | { mode: 'all' } | { mode: 'elements', elements: string[] };

/**
 * The events of a generation run, in order: `start`, then per target `planned`, `log` lines, `merged` (an existing
 * project), `generated` and `tasks`, or `skipped` or `failed`; `done` last.
 */
export type GenerationEvent =
    | { type: 'start', selection: GenerationSelection, targets: { extension: string, out: string }[] }
    | { type: 'planned', target: string, mode: 'create' | 'sync', elements: string[], steps: string[] }
    | { type: 'log', target: string, line: string }
    | { type: 'merged', target: string, report: SyncReport }
    | { type: 'generated', target: string, elements: { qn: string, files: string[] }[], references: number }
    | { type: 'tasks', target: string, tasks: { qn: string, missing: string[] }[] }
    | { type: 'skipped', target: string, reason: string }
    | { type: 'failed', target?: string, message: string }
    | { type: 'done', generated: number, tasks: number, failed: boolean };

export interface GenerationOptions {
    /** The workspace folder, with `appling.config.json`. */
    root: string;
    graph: Graph;
    selection: GenerationSelection;
    /** Default: the targets of `appling.config.json`. */
    targets?: Target[];
    /** Default: `loadExtension`, resolved from the workspace. */
    load?(name: string, root: string): Promise<CodegenExtension>;
    onEvent?(event: GenerationEvent): void;
}

/**
 * Generates into every target. A target without a registry is created whole, from its setup on (its out folder must be
 * empty). An existing one is brought up to the model like `appling generate --sync`, its pending migration steps
 * first, but only for the selection: the files of the selected elements are merged three ways, and every element
 * whose files were all merged counts as generated with them (files are shared, such as a `models.py`). Generation
 * records the code references of what it wrote in `.appling/references.json` and the fingerprints of the generated
 * elements in `.appling/generation.json`; what it cannot complete stays in the registry as tasks.
 */
export async function generateElements(options: GenerationOptions): Promise<{ generated: Record<string, string[]>, tasks: number, failed: boolean }> {
    const { root, graph } = options;
    const emit = options.onEvent ?? (() => undefined);
    const targets = options.targets ?? readConfig(root).generate ?? [];
    const load = options.load ?? loadExtension;
    const result = { generated: {} as Record<string, string[]>, tasks: 0, failed: false };
    emit({ type: 'start', selection: options.selection, targets: targets.map(t => ({ extension: t.extension, out: t.out })) });
    if (!targets.length) {
        emit({ type: 'failed', message: 'No targets: add "generate": [{ "extension": "...", "out": "..." }] to appling.config.json.' });
        result.failed = true;
    }
    for (const target of targets) {
        try {
            const generated = await generateTarget(root, graph, target, options.selection, await load(target.extension, root), emit);
            if (!generated) continue;
            result.generated[target.out] = generated.elements;
            result.tasks += generated.tasks;
        } catch (error) {
            emit({ type: 'failed', target: target.out, message: (error as Error).message });
            result.failed = true;
        }
    }
    emit({ type: 'done', generated: Object.values(result.generated).reduce((sum, e) => sum + e.length, 0), tasks: result.tasks, failed: result.failed });
    return result;
}

async function generateTarget(root: string, graph: Graph, target: Target, selection: GenerationSelection, extension: CodegenExtension, emit: (event: GenerationEvent) => void): Promise<{ elements: string[], tasks: number } | undefined> {
    const out = resolve(root, target.out);
    const options = target.options ?? {};
    const name = String(options.name ?? basename(out));
    const planned = plan(graph, extension, name, options);
    const log = (line: string) => emit({ type: 'log', target: target.out, line });
    const exists = !!readRegistry(out);
    const record = readGenerations(root)[target.out];
    const outstanding = outstandingElements(graph, [record]);
    const selected = exists ? select(graph, selection, outstanding) : new Set(graph.nodes.map(n => n.qn));
    if (!selected.size) {
        emit({ type: 'skipped', target: target.out, reason: selection.mode === 'outstanding' ? 'Nothing changed since the last generation.' : 'No such elements.' });
        return undefined;
    }
    if (exists && !existsSync(join(out, BASELINE))) throw new Error(`${target.out} has no generation baseline. Generate it with this version of appling first.`);
    if (!exists && existsSync(out) && readdirSync(out).length) throw new Error(`${target.out} is not empty and has no registry: generation creates a new draft project there only once.`);
    const missing = checkPrerequisites(extension.prerequisites ?? [], graph);
    if (missing.length) throw new Error(missing.join('\n'));

    const entries = new Map(planned.entries.map(e => [e.qn, e]));
    const parents = new Map(graph.edges.filter(e => e.kind === 'contains').map(e => [e.to, e.from]));
    /** The nearest element (itself or a parent) that has files of its own: where its code is. */
    const owner = (qn: string): RegistryEntry | undefined => {
        for (let current: string | undefined = qn; current; current = parents.get(current)) {
            const entry = entries.get(current);
            if (entry?.files.length) return entry;
        }
        return undefined;
    };
    const written: Written[] = [];
    let elements: Set<string>;
    if (!exists) {
        emit({ type: 'planned', target: target.out, mode: 'create', elements: [...selected], steps: planned.steps.map(s => `${s.node}: ${describe(s.step)}`) });
        runPlan(planned, out, log, written);
        elements = selected;
    } else {
        const files = selection.mode === 'all' ? undefined : [...new Set([...selected].flatMap(qn => owner(qn)?.files ?? []))];
        elements = selection.mode === 'all' ? selected : new Set([...selected, ...graph.nodes.map(n => n.qn).filter(qn => {
            const files$ = owner(qn)?.files;
            return files$ && files$.every(f => files!.includes(f));
        })]);
        const steps = planned.steps.filter(s => elements.has(s.node)).map(s => `${s.node}: ${describe(s.step)}`);
        emit({ type: 'planned', target: target.out, mode: 'sync', elements: [...elements], steps });
        if (extension.migrate) {
            const changes = pendingChanges(graph, readApplied(out), new Date().toISOString().replace(/\D/g, '').slice(0, 14));
            if (changes.length) runMigrations(out, planMigrations(graph, extension, name, options, out, changes), changes, log);
        }
        const temp = mkdtempSync(join(tmpdir(), 'appling-generate-'));
        try {
            const next = join(temp, basename(out));
            runPlan(planned, next, line => log(`  ${line}`), written);
            const report = mergeGeneration(out, next, extension.syncExclude ?? [], files && { files, entries: [...elements] });
            emit({ type: 'merged', target: target.out, report });
        } finally {
            rmSync(temp, { recursive: true, force: true });
        }
    }
    const references = recordWritten(root, target.out, graph, written, elements);
    const registry = readRegistry(out)!;
    emit({
        type: 'generated', target: target.out, references,
        elements: [...elements].map(qn => ({ qn, files: registry.entries[qn]?.files ?? [] }))
    });
    const tasks = [...elements].flatMap(qn => {
        const entry = registry.entries[qn];
        return entry && entry.status !== 'done' && entry.missing.length ? [{ qn, missing: entry.missing.map(m => m.what) }] : [];
    });
    emit({ type: 'tasks', target: target.out, tasks });
    return { elements: [...elements], tasks: tasks.length };
}

/** The selected elements of a graph; an element brings its members. */
function select(graph: Graph, selection: GenerationSelection, outstanding: Set<string>): Set<string> {
    if (selection.mode === 'all') return new Set(graph.nodes.map(n => n.qn));
    if (selection.mode === 'outstanding') return outstanding;
    return new Set(graph.nodes.map(n => n.qn).filter(qn => selection.elements.some(e => qn === e || qn.startsWith(`${e}.`))));
}

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { Registry } from './run.js';
import { readRegistry, writeRegistry } from './run.js';

/** Paths sync never reads or writes, in every project. */
const ALWAYS = ['.appling/**', '.git/**', 'node_modules/**'];

export const BASELINE = join('.appling', 'baseline');
const BASELINE_REGISTRY = join('.appling', 'baseline-tasks.json');

export interface SyncReport {
    updated: string[];
    added: string[];
    removed: string[];
    /** Files where your changes and the model's changes were merged. */
    merged: string[];
    /** Files left with conflict markers. */
    conflicts: string[];
    /** Files the model no longer produces that you changed, so they were kept. */
    kept: string[];
}

/** Stores what generation produced, the base of the next sync: the files and the registry. */
export function saveBaseline(out: string, exclude: string[]): void {
    const root = resolve(out);
    const baseline = join(root, BASELINE);
    rmSync(baseline, { recursive: true, force: true });
    for (const file of projectFiles(root, exclude)) {
        mkdirSync(dirname(join(baseline, file)), { recursive: true });
        cpSync(join(root, file), join(baseline, file));
    }
    const registry = readRegistry(root);
    if (registry) writeFileSync(join(root, BASELINE_REGISTRY), JSON.stringify(registry, null, 2) + '\n');
}

/**
 * Merges a fresh generation of the changed model into a generated project, three ways: the baseline of the
 * last generation, the project as it is, and the new generation. Then the new generation becomes the baseline.
 */
export function mergeGeneration(out: string, next: string, exclude: string[]): SyncReport {
    const [root, fresh] = [resolve(out), resolve(next)];
    const baseline = join(root, BASELINE);
    const report: SyncReport = { updated: [], added: [], removed: [], merged: [], conflicts: [], kept: [] };
    const read = (path: string) => (existsSync(path) ? readFileSync(path) : undefined);
    const nextFiles = new Set(projectFiles(fresh, exclude));
    for (const file of nextFiles) {
        const [base, mine, theirs] = [read(join(baseline, file)), read(join(root, file)), read(join(fresh, file))!];
        const target = join(root, file);
        if (!mine) {
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, theirs);
            report.added.push(file);
        } else if (mine.equals(theirs) || (base && theirs.equals(base))) {
            continue;
        } else if (base && mine.equals(base)) {
            writeFileSync(target, theirs);
            report.updated.push(file);
        } else {
            const merge = spawnSync('git', ['merge-file', '-p', '-L', 'yours', '-L', 'last generation', '-L', 'model', target, base ? join(baseline, file) : '/dev/null', join(fresh, file)]);
            writeFileSync(target, merge.stdout);
            (merge.status === 0 ? report.merged : report.conflicts).push(file);
        }
    }
    for (const file of projectFiles(baseline, exclude).filter(f => !nextFiles.has(f))) {
        const mine = read(join(root, file));
        if (!mine) continue;
        if (mine.equals(read(join(baseline, file))!)) {
            rmSync(join(root, file));
            report.removed.push(file);
        } else {
            report.kept.push(file);
        }
    }
    mergeRegistry(root, fresh, report);
    rmSync(baseline, { recursive: true, force: true });
    cpSync(join(fresh, BASELINE), baseline, { recursive: true });
    cpSync(join(fresh, BASELINE_REGISTRY), join(root, BASELINE_REGISTRY));
    return report;
}

/**
 * The registry of the new generation, keeping the work done since the last one: an entry stays `done`, with
 * its attempts and notes, while what was missing is still the same. Conflicts become tasks of the project.
 */
function mergeRegistry(root: string, fresh: string, report: SyncReport): void {
    const next = readRegistry(fresh)!;
    const current = readRegistry(root);
    const base = existsSync(join(root, BASELINE_REGISTRY)) ? JSON.parse(readFileSync(join(root, BASELINE_REGISTRY), 'utf8')) as Registry : undefined;
    for (const entry of Object.values(next.entries)) {
        const before = current?.entries[entry.qn];
        if (!before) continue;
        const unchanged = JSON.stringify(base?.entries[entry.qn]?.missing.map(m => m.what)) === JSON.stringify(entry.missing.map(m => m.what));
        if (before.status === 'done' && unchanged) {
            entry.status = 'done';
            entry.missing = [];
        }
        entry.attempts = before.attempts;
        entry.notes = before.notes;
    }
    for (const file of report.conflicts) {
        next.entries[`(sync) ${file}`] = {
            qn: `(sync) ${file}`, kind: 'File', layer: 'cross', status: 'todo', steps: [], files: [file],
            missing: [{ what: `resolve the conflict markers in ${file} between your changes and the model`, context: { props: {}, related: [] } }]
        };
    }
    writeRegistry(root, next);
}

/** The files of a project relative to its root, without excluded paths. */
export function projectFiles(root: string, exclude: string[]): string[] {
    if (!existsSync(root)) return [];
    const patterns = [...ALWAYS, ...exclude].map(glob);
    const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => {
        const path = join(dir, name);
        const rel = relative(root, path);
        if (patterns.some(p => p.test(rel) || p.test(`${rel}/`))) return [];
        return statSync(path).isDirectory() ? walk(path) : [rel];
    });
    return walk(root).sort();
}

/** `**` matches any path, `*` any name within one folder. */
function glob(pattern: string): RegExp {
    const source = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*');
    return new RegExp(`^${source}$`);
}

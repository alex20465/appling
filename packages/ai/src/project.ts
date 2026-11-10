import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { AstUtils, URI } from 'langium';
import { buildSources, type Model, type Workspace } from '@appling/lang';
import { readConfig, readRegistry, workspaceImplementation, writeRegistry, type Registry, type RegistryEntry, type Status } from '@appling/codegen';
import {
    applyEdit, buildGraph, checkScenarios, findApplingFiles, latestRelease, qualifiedNames, readReleases, recordReferences, resolveReferences,
    type CodeReference, type EditOperation, type EditResult, type Graph, type ResolvedReference
} from '@appling/model';

/** After this many attempts an entry stops coming back from `nextTask`. */
export const MAX_ATTEMPTS = 3;

export type Sources = Record<string, string>;

/** The model files of a workspace folder: reading, checking, querying and editing them. */
export class Project {

    readonly root: string;

    constructor(root: string) {
        this.root = resolve(root);
    }

    sources(): Sources {
        return Object.fromEntries(findApplingFiles(this.root).map(f => [URI.file(f).toString(), readFileSync(f, 'utf8')]));
    }

    /** The errors of the model, as `appling check` reports them: once there are none, the failing scenarios. */
    async check(sources = this.sources()): Promise<string[]> {
        const { documents, services } = await buildSources(sources);
        const errors = documents.flatMap(doc => (doc.diagnostics ?? []).filter(d => d.severity === 1).map(d =>
            `${relative(this.root, doc.uri.fsPath)}:${d.range.start.line + 1}:${d.range.start.character + 1} ${typeof d.message === 'string' ? d.message : d.message.value}`));
        if (errors.length) return errors;
        return checkScenarios(models(documents), services).map(p => `${relative(this.root, URI.parse(p.uri).fsPath)}:${p.range.start.line + 1}:${p.range.start.character + 1} ${p.message}`);
    }

    async graph(sources = this.sources()): Promise<Graph> {
        const { documents, services } = await buildSources(sources);
        return buildGraph(models(documents), services);
    }

    /** The source text of one element. */
    async source(qn: string, sources = this.sources()): Promise<string | undefined> {
        const workspace = await buildSources(sources);
        const node = [...qualifiedNames(models(workspace.documents))].find(([, name]) => name === qn)?.[0];
        return node && `${relative(this.root, AstUtils.getDocument(node).uri.fsPath)}:\n${node.$cstNode!.text}`;
    }

    async edit(operation: EditOperation, sources = this.sources()): Promise<EditResult> {
        return applyEdit(sources, operation, { release: latestRelease(readReleases(this.root)) });
    }

    /** Writes one model file when the workspace validates with it; paths stay inside the workspace. */
    async writeModelFile(path: string, source: string): Promise<{ ok: boolean, errors?: string[], written?: string }> {
        const file = resolve(this.root, path);
        if (!file.startsWith(this.root + sep) || !file.endsWith('.appling')) return { ok: false, errors: ['The path must be a .appling file inside the workspace.'] };
        const sources = { ...this.sources(), [URI.file(file).toString()]: source };
        const before = new Set(await this.check());
        const errors = (await this.check(sources)).filter(e => !before.has(e));
        if (errors.length) return { ok: false, errors };
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, source);
        return { ok: true, written: relative(this.root, file) };
    }

    write(sources: Sources): string[] {
        const current = this.sources();
        const changed = Object.keys(sources).filter(uri => sources[uri] !== current[uri]);
        for (const uri of changed) writeFileSync(URI.parse(uri).fsPath, sources[uri]);
        return changed.map(uri => relative(this.root, URI.parse(uri).fsPath));
    }

    /** Where one element and its members are implemented; without a name, every reference that is not current. */
    async references(qn?: string): Promise<ResolvedReference[]> {
        const all = resolveReferences(this.root, await this.graph());
        return qn ? all.filter(r => r.qn === qn || r.qn.startsWith(`${qn}.`) || r.qn.startsWith(`${qn}#`)) : all.filter(r => r.status !== 'current');
    }

    async recordReferences(qn: string, ranges: { file: string, start: number, end: number }[]): Promise<CodeReference[] | { error: string }> {
        const graph = await this.graph();
        // an element, or a line of one by its sub-anchor address, such as `sales.PlaceOrder#step[2]`
        if (!graph.nodes.some(n => n.qn === qn) && !graph.anchors?.some(a => a.address === qn)) return { error: `No element or sub-anchor ${qn}.` };
        try {
            return recordReferences(this.root, qn, ranges);
        } catch (error) {
            return { error: (error as Error).message };
        }
    }

    /** The generated projects that have a task registry, from `appling.config.json`. */
    targets(): { out: string, registry: Registry }[] {
        return (readConfig(this.root).generate ?? []).flatMap(t => {
            const out = resolve(this.root, t.out);
            const registry = readRegistry(out);
            return registry ? [{ out, registry }] : [];
        });
    }

    /** How far every element is implemented: counts per state and the elements that are not implemented, with their state. */
    async implementation(module?: string): Promise<{ counts: Record<string, number>, outstanding: number, elements: { qn: string, state: string, tasks: number, outstanding: boolean }[] }> {
        const { states } = workspaceImplementation(this.root, await this.graph());
        const all = Object.entries(states).filter(([qn]) => !module || qn === module || qn.startsWith(`${module}.`));
        const counts: Record<string, number> = {};
        for (const [, s] of all) counts[s.state] = (counts[s.state] ?? 0) + 1;
        const open = all.filter(([, s]) => s.state !== 'implemented' || s.outstanding);
        return { counts, outstanding: all.filter(([, s]) => s.outstanding).length, elements: open.slice(0, 200).map(([qn, s]) => ({ qn, state: s.state, tasks: s.tasks, outstanding: s.outstanding })) };
    }

    /** The first open registry entry in dependency order that has attempts left and that `skip` does not pass over. */
    nextTask(target?: string, skip?: (entry: RegistryEntry) => boolean): { out: string, entry: RegistryEntry } | undefined {
        for (const { out, registry } of this.select(target)) {
            const entry = Object.values(registry.entries).find(e => (e.status === 'todo' || e.status === 'partial') && e.missing.length && (e.attempts ?? 0) < MAX_ATTEMPTS && !skip?.(e));
            if (entry) return { out, entry };
        }
        return undefined;
    }

    /** Records an attempt on an entry; an entry that is still open after the last attempt keeps a note why. */
    updateTask(qn: string, status: Status, note?: string, target?: string): RegistryEntry | undefined {
        for (const { out, registry } of this.select(target)) {
            const entry = registry.entries[qn];
            if (!entry) continue;
            entry.status = status;
            entry.attempts = (entry.attempts ?? 0) + 1;
            if (status === 'done') entry.missing = [];
            if (note) entry.notes = [...(entry.notes ?? []), note];
            if (status !== 'done' && entry.attempts >= MAX_ATTEMPTS) entry.notes = [...(entry.notes ?? []), `stopped after ${entry.attempts} attempts`];
            writeRegistry(out, registry);
            return entry;
        }
        return undefined;
    }

    runTests(target?: string): { out: string, passed: boolean, output: string } | undefined {
        const selected = this.select(target)[0];
        const command = selected?.registry.test;
        if (!selected || !command) return undefined;
        const result = spawnSync(command[0], command.slice(1), { cwd: selected.out, encoding: 'utf8' });
        const output = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error?.message ?? ''}`;
        return { out: selected.out, passed: result.status === 0, output: output.slice(-4000) };
    }

    private select(target?: string): { out: string, registry: Registry }[] {
        return this.targets().filter(t => !target || t.out === resolve(this.root, target));
    }
}

function models(documents: Workspace['documents']): Model[] {
    return documents.map(d => d.parseResult.value as Model);
}

/** One element with what it contains and references, or a filtered list of elements. */
export function queryGraph(graph: Graph, query: { qn?: string, kind?: string, module?: string, search?: string }): unknown {
    if (query.qn) {
        const node = graph.nodes.find(n => n.qn === query.qn);
        if (!node) return { error: `No element ${query.qn}.` };
        const edges = graph.edges.filter(e => e.from === node.qn || e.to === node.qn);
        return {
            ...node,
            contains: edges.filter(e => e.kind === 'contains' && e.from === node.qn).map(e => e.to),
            refersTo: edges.filter(e => e.kind !== 'contains' && e.from === node.qn).map(e => ({ kind: e.kind, to: e.to })),
            referredBy: edges.filter(e => e.kind !== 'contains' && e.to === node.qn).map(e => ({ kind: e.kind, from: e.from }))
        };
    }
    const search = query.search?.toLowerCase();
    const matches = graph.nodes.filter(n => (!query.kind || n.kind === query.kind) && (!query.module || n.module === query.module || n.qn === query.module) && (!search || n.qn.toLowerCase().includes(search)));
    return { count: matches.length, elements: matches.slice(0, 200).map(n => ({ qn: n.qn, kind: n.kind, layer: n.layer })) };
}

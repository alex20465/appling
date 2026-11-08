import type { Graph, GraphNode } from './graph.js';
import type { ResolvedReference } from './references.js';

/**
 * How far an element of the model is implemented, from its code references, the registry tasks of the generated
 * projects and the last generation. Pure and browser safe: the IDE server computes it for every snapshot and the
 * IDE client draws it (gutter marks, canvas marks).
 *
 * - `implemented`: a current code reference, or generated code of the last generation the element has not changed since.
 * - `partial`: an open registry task, next to code that exists.
 * - `unimplemented`: no code reference and no generated code, or the element is new or changed since the last generation.
 * - `shifted`: a reference whose anchor moved; `broken`: a reference whose file or anchor is gone.
 */
export type ImplementationState = 'implemented' | 'partial' | 'unimplemented' | 'shifted' | 'broken';

export const IMPLEMENTATION_STATES: ImplementationState[] = ['implemented', 'partial', 'unimplemented', 'shifted', 'broken'];

/** What the state computation needs of a registry entry (`RegistryEntry` of `@appling/codegen`). */
export interface TaskEntry {
    qn: string;
    status: string;
    missing: unknown[];
}

export interface ElementImplementation {
    state: ImplementationState;
    /** Code references that are current. */
    references: number;
    /** Open registry tasks (missing items) over every target. */
    tasks: number;
    /** New or changed since the last generation of a target: generation would write it. */
    outstanding: boolean;
}

/** What one target's last generation wrote: a fingerprint per element. */
export interface GenerationRecord {
    at: string;
    fingerprints: Record<string, string>;
}

/** A short hash of what makes an element: its kind and its properties as canonical text. Members have their own. */
export function fingerprint(node: GraphNode): string {
    const text = JSON.stringify([node.kind, node.props]);
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

/** The fingerprints of every element of a graph. */
export function fingerprints(graph: Graph): Record<string, string> {
    return Object.fromEntries(graph.nodes.map(n => [n.qn, fingerprint(n)]));
}

/**
 * The elements generation would write: new or changed since the last generation of any target. A target that was
 * never generated makes every element outstanding; without targets nothing is.
 */
export function outstandingElements(graph: Graph, records: (GenerationRecord | undefined)[]): Set<string> {
    return new Set(graph.nodes.filter(n => records.some(r => r?.fingerprints[n.qn] !== fingerprint(n))).map(n => n.qn));
}

export interface ImplementationInput {
    references: ResolvedReference[];
    /** The registry entries of every generated project. */
    tasks: TaskEntry[];
    outstanding: Set<string>;
}

/** The implementation state of every element of the graph. */
export function implementationStates(graph: Graph, input: ImplementationInput): Record<string, ElementImplementation> {
    const references = Map.groupBy(input.references.filter(r => r.status !== 'orphaned'), r => r.qn);
    const tasks = Map.groupBy(input.tasks, t => t.qn);
    const result: Record<string, ElementImplementation> = {};
    for (const node of graph.nodes) {
        const own = references.get(node.qn) ?? [];
        const entries = tasks.get(node.qn) ?? [];
        const open = entries.filter(e => e.status !== 'done' && e.missing.length > 0);
        const current = own.filter(r => r.status === 'current').length;
        const outstanding = input.outstanding.has(node.qn);
        const generated = !outstanding && entries.some(e => e.status === 'generated' || e.status === 'done' || e.status === 'partial');
        const state: ImplementationState = own.some(r => r.status === 'broken') ? 'broken'
            : own.some(r => r.status === 'shifted') ? 'shifted'
            : open.length ? (current || entries.some(e => e.status === 'partial') && !outstanding ? 'partial' : 'unimplemented')
            : current || generated ? 'implemented'
            : 'unimplemented';
        result[node.qn] = { state, references: current, tasks: open.reduce((sum, e) => sum + e.missing.length, 0), outstanding };
    }
    return result;
}

/** One state for several: broken or shifted when any is, implemented or unimplemented when all are, else partial. */
export function rollupState(states: ImplementationState[]): ImplementationState | undefined {
    if (!states.length) return undefined;
    for (const worst of ['broken', 'shifted'] as const) if (states.includes(worst)) return worst;
    if (states.every(s => s === 'implemented')) return 'implemented';
    if (states.every(s => s === 'unimplemented')) return 'unimplemented';
    return 'partial';
}

/** The mark of one model line: the element declared there. */
export interface LineMark {
    /** From 1. */
    line: number;
    qn: string;
    state: ImplementationState;
    outstanding: boolean;
}

/**
 * The marks of the model files: one per line that declares an element, the innermost one when several start on the
 * same line. Keys are the files' URIs, lines are sorted.
 */
export function lineMarks(
    locations: Record<string, { uri: string, start: number, end: number }>,
    texts: Record<string, string>,
    states: Record<string, ElementImplementation>
): Record<string, LineMark[]> {
    const starts = new Map<string, number[]>();
    const lineOf = (uri: string, offset: number) => {
        let table = starts.get(uri);
        if (!table) {
            const text = texts[uri] ?? '';
            table = [0];
            for (let i = 0; i < text.length; i++) if (text[i] === '\n') table.push(i + 1);
            starts.set(uri, table);
        }
        let [low, high] = [0, table.length - 1];
        while (low < high) {
            const middle = (low + high + 1) >> 1;
            if (table[middle] <= offset) low = middle;
            else high = middle - 1;
        }
        return low + 1;
    };
    const best = new Map<string, Map<number, { mark: LineMark, start: number, span: number }>>();
    for (const [qn, location] of Object.entries(locations)) {
        const implementation = states[qn];
        if (!implementation || !(location.uri in texts)) continue;
        const line = lineOf(location.uri, location.start);
        const lines = best.get(location.uri) ?? new Map();
        best.set(location.uri, lines);
        const span = location.end - location.start;
        const seen = lines.get(line);
        if (seen && (seen.start > location.start || (seen.start === location.start && seen.span <= span))) continue;
        lines.set(line, { mark: { line, qn, state: implementation.state, outstanding: implementation.outstanding }, start: location.start, span });
    }
    return Object.fromEntries([...best].map(([uri, lines]) => [uri, [...lines.values()].map(l => l.mark).sort((a, b) => a.line - b.line)]));
}

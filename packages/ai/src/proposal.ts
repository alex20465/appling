import { relative } from 'node:path';
import { URI } from 'langium';
import type { EditOperation, Graph } from '@appling/model';
import type { Project, Sources } from './project.js';
import type { ProposalContext } from './tools.js';

export interface Hunk {
    file: string;
    line: number;
    removed: string[];
    added: string[];
}

/** The edits collected on a working copy, with their text and graph differences, for a person to accept or reject. */
export interface Proposal {
    operations: EditOperation[];
    hunks: Hunk[];
    graph: { added: string[], removed: string[], changed: string[] };
}

export async function proposal(project: Project, context: ProposalContext): Promise<Proposal> {
    const [before, after] = [await project.graph(context.original), await project.graph(context.sources())];
    return { operations: context.operations, hunks: hunks(project.root, context.original, context.sources()), graph: graphDiff(before, after) };
}

/** One hunk per changed file, from the first to the last changed line. */
export function hunks(root: string, before: Sources, after: Sources): Hunk[] {
    return Object.keys(after).filter(uri => before[uri] !== after[uri]).map(uri => {
        const [a, b] = [(before[uri] ?? '').split('\n'), after[uri].split('\n')];
        let start = 0;
        while (start < a.length && start < b.length && a[start] === b[start]) start++;
        let end = 0;
        while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
        return { file: relative(root, URI.parse(uri).fsPath), line: start + 1, removed: a.slice(start, a.length - end), added: b.slice(start, b.length - end) };
    });
}

export function graphDiff(before: Graph, after: Graph): Proposal['graph'] {
    const old = new Map(before.nodes.map(n => [n.qn, JSON.stringify(n.props)]));
    const next = new Map(after.nodes.map(n => [n.qn, JSON.stringify(n.props)]));
    return {
        added: [...next.keys()].filter(qn => !old.has(qn)),
        removed: [...old.keys()].filter(qn => !next.has(qn)),
        changed: [...next.keys()].filter(qn => old.has(qn) && old.get(qn) !== next.get(qn))
    };
}

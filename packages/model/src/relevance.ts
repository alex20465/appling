import type { Graph } from './graph.js';

export type RelevanceLevel = 'core' | 'supporting' | 'peripheral';

/** The score range of each level; the graph places an element within its level. */
export const RELEVANCE_LEVELS: Record<RelevanceLevel, [number, number]> = {
    core: [0.7, 1],
    supporting: [0.35, 0.7],
    peripheral: [0, 0.35]
};

/** The level a score falls in. */
export function relevanceLevel(score: number): RelevanceLevel {
    return score >= RELEVANCE_LEVELS.core[0] ? 'core' : score >= RELEVANCE_LEVELS.supporting[0] ? 'supporting' : 'peripheral';
}

/**
 * How much every module and top level declaration matters to the application, from 0 to 1. The graph gives each
 * declaration a score from the declarations that use it and those it uses, on a log scale against the busiest one. A declared level, its own or the nearest module's, maps that score into the level's range.
 * A module scores as its most relevant declaration.
 */
export function relevance(graph: Graph): Map<string, number> {
    const kinds = new Map(graph.nodes.map(n => [n.qn, n.kind]));
    const levels = new Map(graph.nodes.filter(n => n.props.relevance).map(n => [n.qn, n.props.relevance as RelevanceLevel]));
    const parent = new Map(graph.edges.filter(e => e.kind === 'contains').map(e => [e.to, e.from]));
    const declaration = (qn: string) => {
        let current = qn;
        while (parent.has(current) && kinds.get(parent.get(current)!) !== 'Module') current = parent.get(current)!;
        return current;
    };
    const dependents = new Map<string, Set<string>>();
    const dependencies = new Map<string, Set<string>>();
    const add = (map: Map<string, Set<string>>, key: string, value: string) => map.set(key, (map.get(key) ?? new Set()).add(value));
    for (const edge of graph.edges.filter(e => e.kind !== 'contains')) {
        const [from, to] = [declaration(edge.from), declaration(edge.to)];
        if (from === to || kinds.get(from) === 'Module' || kinds.get(to) === 'Module') continue;
        add(dependents, to, from);
        add(dependencies, from, to);
    }
    const declarations = graph.nodes.filter(n => n.kind !== 'Module' && kinds.get(parent.get(n.qn) ?? '') === 'Module');
    const raw = new Map(declarations.map(n => [n.qn, (dependents.get(n.qn)?.size ?? 0) + (dependencies.get(n.qn)?.size ?? 0)]));
    const most = Math.log1p(Math.max(1, ...raw.values()));
    const levelOf = (qn: string): RelevanceLevel | undefined => {
        for (let current: string | undefined = qn; current; current = parent.get(current)) {
            if (levels.has(current)) return levels.get(current);
        }
    };
    const scores = new Map<string, number>();
    for (const node of declarations) {
        const computed = Math.log1p(raw.get(node.qn)!) / most;
        const level = levelOf(node.qn);
        const [low, high] = level ? RELEVANCE_LEVELS[level] : [0, 1];
        scores.set(node.qn, low + (high - low) * computed);
    }
    for (const module of graph.nodes.filter(n => n.kind === 'Module')) {
        const members = declarations.filter(n => parent.get(n.qn) === module.qn).map(n => scores.get(n.qn)!);
        const level = levelOf(module.qn);
        scores.set(module.qn, members.length ? Math.max(...members) : level ? RELEVANCE_LEVELS[level][0] : 0);
    }
    return scores;
}

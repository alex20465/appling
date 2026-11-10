import { AstUtils, GrammarUtils, type AstNode } from 'langium';
import { isScenario, type ApplingServices, type Model } from '@appling/lang';
import { buildGraph, qualifiedNames, type Graph } from './graph.js';
import { Simulator, type ScenarioResult } from './simulator.js';

/** A scenario whose `then` does not hold, located at the scenario's name. */
export interface ScenarioProblem {
    scenario: string;
    uri: string;
    range: { start: { line: number, character: number }, end: { line: number, character: number } };
    message: string;
}

/** Runs every scenario of a graph in the simulator. A scenario the simulator cannot run is left out. */
export function runScenarios(graph: Graph, now?: Date): ScenarioResult[] {
    const simulator = new Simulator(graph, now);
    return graph.nodes.filter(n => n.kind === 'Scenario').flatMap(node => {
        try {
            return [simulator.scenario(node.qn)];
        } catch {
            return [];
        }
    });
}

/**
 * Runs every scenario of resolved, error free models and reports each failing one, as `appling check` does.
 * Each failure of a scenario becomes one problem.
 */
export function checkScenarios(models: Model[], services: ApplingServices, now?: Date): ScenarioProblem[] {
    const nodes = new Map([...qualifiedNames(models)].map(([node, qn]) => [qn, node]));
    return runScenarios(buildGraph(models, services), now).flatMap(result => {
        const node = nodes.get(result.scenario);
        if (!node || !isScenario(node)) return [];
        const range = (GrammarUtils.findNodeForProperty(node.$cstNode, 'name') ?? node.$cstNode)!.range;
        const uri = AstUtils.getDocument(node as AstNode).uri.toString();
        return result.failures.map(failure => ({ scenario: result.scenario, uri, range, message: `Scenario ${node.name} fails: ${failure}` }));
    });
}

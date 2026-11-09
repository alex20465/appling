import {
    isAction, isCallStep, isExternalOperation, isRole, isUseCase,
    type Action, type Actor, type Endpoint, type EndpointCall, type ErrorDecl, type ExternalOperation, type Query, type Scenario, type UseCase
} from './generated/ast.js';

/** The endpoint an endpoint call names by its verb and path, or undefined. */
export function endpointOf(call: EndpointCall): Endpoint | undefined {
    return call.api.ref?.endpoints.find(e => e.verb === call.verb && e.path === call.path);
}

/** What a scenario's `when` runs: the called element, or the target of the called endpoint. */
export function scenarioTarget(scenario: Scenario): Action | UseCase | Query | ExternalOperation | undefined {
    if (scenario.call) return scenario.call.target.ref;
    return scenario.endpoint ? endpointOf(scenario.endpoint)?.target.ref : undefined;
}

/** The errors a scenario's `when` may fail with: the action's own, or those of what a use case's steps call. */
export function scenarioErrors(scenario: Scenario): ErrorDecl[] {
    const target = scenarioTarget(scenario);
    return target ? errorsOf(target, new Set()) : [];
}

function errorsOf(target: Action | UseCase | Query | ExternalOperation, seen: Set<UseCase>): ErrorDecl[] {
    if (isAction(target) || isExternalOperation(target)) return target.errors;
    if (!isUseCase(target) || seen.has(target)) return [];
    seen.add(target);
    return target.steps.filter(isCallStep).flatMap(step => {
        const called = step.call.target.ref;
        return [...(called ? errorsOf(called, seen) : []), ...step.handlers.flatMap(h => h.call.target.ref ? errorsOf(h.call.target.ref, seen) : [])];
    });
}

/** The actor a scenario runs as: the one it names, or the first declared actor holding the role it names. */
export function scenarioActor(scenario: Scenario, actors: Actor[]): Actor | undefined {
    const persona = scenario.actor?.persona.ref;
    if (!isRole(persona)) return persona;
    return actors.find(a => a.roles.some(r => r.ref === persona));
}

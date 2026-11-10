import {
    isAction, isCallStep, isExternalOperation, isRole, isUseCase,
    type Action, type Actor, type ErrorDecl, type ExternalOperation, type Query, type Scenario, type UseCase
} from './generated/ast.js';

/** What a scenario's `when` runs. */
export function scenarioTarget(scenario: Scenario): Action | UseCase | Query | ExternalOperation | undefined {
    return scenario.call.target.ref;
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

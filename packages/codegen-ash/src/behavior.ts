import type { MapContext, Step } from '@appling/codegen';
import type { ExprData, GraphNode, TypeData } from '@appling/model';
import { ashExpr, constant, lastOf, parentOf, validation } from './elixir.js';
import { addAuthorizer, addExtension, addToSection, prependToSection } from './resource.js';
import { enforced } from './roles.js';
import { coveredByScenario } from './scenario-tests.js';
import { preconditionTests } from './model-tests.js';
import { attributeType, children, fileOf, patch, sectionLines, snake, storedAttributes, task, typeModule } from './naming.js';

/**
 * An action on an entity becomes an update action of its resource: arguments, precondition validations, changes and
 * its state transition. An action that deletes its record (`delete self`) without a transition becomes a destroy action.
 */
export function actionSteps(action: GraphNode, context: MapContext): Step[] {
    const entity = action.data.entity ? context.node(action.data.entity as string) : undefined;
    if (!entity) return [task(`implement ${lastOf(action.qn)} as a generic action`)];
    const tasks: Step[] = [];
    const transitions = context.graph.nodes.filter(n => n.kind === 'Transition' && n.data.action === action.qn);
    const destroy = !transitions.length && children(action, context).find(c => c.kind === 'DeleteEffect' && c.data.self);
    const args = children(action, context, 'Param').map(input => {
        const type = input.data.type as TypeData;
        return { name: lastOf(input.qn), type: type.many ? `{:array, ${attributeType(type, context, true)}}` : attributeType(type, context, true), optional: type.optional };
    });
    const validations: { rule: string, message: string }[] = [];
    const stored = storedAttributes(entity, context);
    const preconditions = (action.data.preconditions ?? []) as { condition: ExprData, error?: string }[];
    preconditions.forEach((precondition, i) => {
        const rule = validation(precondition.condition, stored, context.node);
        const message = precondition.error ? lastOf(precondition.error) : (action.props.preconditions as string[])[i];
        if (rule) validations.push({ rule, message });
        else tasks.push(task(`check the precondition ${(action.props.preconditions as string[])[i]} in ${lastOf(action.qn)}`));
    });
    for (const transition of transitions.filter(t => t.data.guard)) {
        const rule = validation(transition.data.guard as ExprData, stored, context.node);
        if (rule && transitions.length === 1) validations.push({ rule, message: 'invalid transition' });
        else tasks.push(task(`check the guard ${transition.props.guard} of ${lastOf(transition.qn)}`));
    }
    const changes: string[] = [];
    const effects = [...children(action, context), ...transitions.flatMap(t => children(t, context))].filter(c => c.kind.endsWith('Effect') && c !== destroy);
    for (const effect of effects) {
        const change = effectChange(effect, context);
        if (change) changes.push(change);
        else tasks.push(task(`apply the effect ${lastOf(effect.qn)} in ${lastOf(action.qn)}, for example with ${effect.kind === 'EmitEffect' || effect.kind === 'SetEffect' ? 'an Ash notifier or a change' : 'an after_action change that writes the related records'}`));
    }
    const targets = [...new Set(transitions.map(t => t.data.to as string))];
    if (targets.length > 1) tasks.push(task(`pick the target state of ${lastOf(action.qn)} among ${targets.join(', ')}`));
    const lines = sectionLines(context, 'behavior/action.ex.njk', {
        type: destroy ? 'destroy' : 'update', name: snake(lastOf(action.qn)), arguments: args, validations, changes, state: targets.length === 1 ? targets[0] : undefined
    });
    if (action.data.consistency === 'eventual') tasks.push(task(`run ${lastOf(action.qn)} with eventual consistency, for example through AshOban`));
    // A scenario that runs the action replaces its guessed precondition tests.
    const tests = preconditions.length && !coveredByScenario(action.qn, context) ? preconditionTests(action, entity, context) : [];
    return [patch(fileOf(entity, context), existing => addToSection(existing, 'actions', lines)), ...tasks, ...tests];
}

export function effectChange(effect: GraphNode, context: MapContext): string | undefined {
    if (effect.kind !== 'SetEffect') return undefined;
    const field = lastOf(effect.data.field as string);
    const value = effect.data.value as ExprData;
    if (value.$type === 'NameExpr' && value.name === 'now' && !value.target) return `set_attribute(:${field}, &DateTime.utc_now/0)`;
    const literal = constant(value, context.node);
    if (literal !== undefined) return `set_attribute(:${field}, ${literal})`;
    const expression = ashExpr(value, context.node);
    return expression && `atomic_update(:${field}, expr(${expression}))`;
}

/**
 * A machine becomes an AshStateMachine section on the resource of its state field. Transitions on an event
 * get an update action named after the event, which the event's publisher has to call.
 */
export function machineSteps(machine: GraphNode, context: MapContext): Step[] {
    const field = context.node(machine.data.field as string)!;
    const entity = context.node(parentOf(field.qn))!;
    const literals = context.children((field.data.type as TypeData).decl!).map(l => lastOf(l.qn));
    const initial = (field.data.default as ExprData | undefined)?.name ?? literals[0];
    const transitions = children(machine, context, 'Transition');
    const byEvent = Map.groupBy(transitions.filter(t => t.data.event), t => t.data.event as string);
    const settings = sectionLines(context, 'behavior/state-machine.ex.njk', { initial, field: lastOf(field.qn) });
    const lines = sectionLines(context, 'behavior/transitions.ex.njk', {
        transitions: transitions.map(t => ({ action: snake(lastOf((t.data.action ?? t.data.event) as string)), from: t.data.from, to: t.data.to }))
    });
    const eventActions = [...byEvent].flatMap(([event, list]) => {
        const targets = [...new Set(list.map(t => t.data.to as string))];
        return targets.length === 1 ? [sectionLines(context, 'behavior/action.ex.njk', { type: 'update', name: snake(lastOf(event)), arguments: [], validations: [], changes: [], state: targets[0] })] : [];
    });
    return [
        patch(fileOf(entity, context), existing => {
            let text = addToSection(addToSection(addExtension(existing, 'AshStateMachine'), 'state_machine', settings), 'state_machine', lines, 'transitions');
            for (const action of eventActions) text = addToSection(text, 'actions', action);
            return text;
        }),
        ...[...byEvent.keys()].map(event => task(`call ${typeModule(entity, context)} :${snake(lastOf(event))} when ${lastOf(event)} happens`))
    ];
}

/** A scheduled job becomes an AshOban trigger that runs the action for every matching row. */
export function jobSteps(job: GraphNode, context: MapContext): Step[] {
    const action = context.node(job.data.action as string)!;
    const entity = action.data.entity ? context.node(action.data.entity as string) : undefined;
    if (!entity || !job.data.schedule) return [task(`run ${lastOf(action.qn)} ${job.data.schedule ? `on the schedule ${job.data.schedule}` : `when ${lastOf(job.data.event as string)} happens`}`)];
    const where = job.data.filter ? ashExpr(job.data.filter as ExprData, context.node) : 'true';
    if (!where) return [task(`run ${lastOf(action.qn)} on the schedule ${job.data.schedule} where ${job.props.filter}`)];
    const name = snake(lastOf(job.qn));
    const module = typeModule(entity, context);
    const pascal = lastOf(job.qn);
    const queue = `${snake(lastOf(entity.qn))}_${name}`;
    const lines = sectionLines(context, 'behavior/trigger.ex.njk', {
        name, action: snake(lastOf(action.qn)), queue, where, schedule: job.data.schedule, module, job: pascal
    });
    const read = sectionLines(context, 'behavior/trigger-read.ex.njk', { name });
    const bypass = sectionLines(context, 'access/oban-bypass.ex.njk', {});
    const authorize = (text: string) => !enforced(context) || text.includes(bypass[0]) ? text : addAuthorizer(prependToSection(text, 'policies', bypass));
    return [
        patch(fileOf(entity, context), existing => authorize(addToSection(addToSection(addExtension(existing, 'AshOban'), 'actions', read), 'oban', lines, 'triggers'))),
        patch('config/config.exs', existing => existing.replace(/queues: \[([^\]]*)\]/, (all, list) => list.includes(`${queue}:`) ? all : `queues: [${list}, ${queue}: 10]`))
    ];
}

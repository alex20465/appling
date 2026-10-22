import type { MapContext, Step } from '@appling/codegen';
import type { ExprData, GraphNode, TypeData } from '@appling/model';
import { ashExpr, constant, lastOf, parentOf, validation } from './elixir.js';
import { addExtension, addToSection } from './resource.js';
import { testSteps } from './tests.js';
import { attributeType, children, fileOf, patch, snake, storedAttributes, task, typeModule } from './naming.js';

/** An action on an entity becomes an update action of its resource: arguments, precondition validations, changes and its state transition. */
export function actionSteps(action: GraphNode, context: MapContext): Step[] {
    const entity = action.data.entity ? context.node(action.data.entity as string) : undefined;
    if (!entity) return [task(`implement ${lastOf(action.qn)} as a generic action`)];
    const tasks: Step[] = [];
    const lines: string[] = [`update :${snake(lastOf(action.qn))} do`, '  require_atomic? false'];
    for (const input of children(action, context, 'Param')) {
        const type = input.data.type as TypeData;
        lines.push(`  argument :${lastOf(input.qn)}, ${type.many ? `{:array, ${attributeType(type, context, true)}}` : attributeType(type, context, true)}, allow_nil?: ${type.optional ? 'true' : 'false'}`);
    }
    const stored = storedAttributes(entity, context);
    const preconditions = (action.data.preconditions ?? []) as { condition: ExprData, error?: string }[];
    preconditions.forEach((precondition, i) => {
        const rule = validation(precondition.condition, stored, context.node);
        const message = precondition.error ? lastOf(precondition.error) : (action.props.preconditions as string[])[i];
        if (rule) lines.push(`  validate ${rule}, message: ${JSON.stringify(message)}`);
        else tasks.push(task(`check the precondition ${(action.props.preconditions as string[])[i]} in ${lastOf(action.qn)}`));
    });
    const transitions = context.graph.nodes.filter(n => n.kind === 'Transition' && n.data.action === action.qn);
    for (const transition of transitions.filter(t => t.data.guard)) {
        const rule = validation(transition.data.guard as ExprData, stored, context.node);
        if (rule && transitions.length === 1) lines.push(`  validate ${rule}, message: "invalid transition"`);
        else tasks.push(task(`check the guard ${transition.props.guard} of ${lastOf(transition.qn)}`));
    }
    const effects = [...children(action, context), ...transitions.flatMap(t => children(t, context))].filter(c => c.kind.endsWith('Effect'));
    for (const effect of effects) {
        const change = effectChange(effect, context);
        if (change) lines.push(`  change ${change}`);
        else tasks.push(task(`apply the effect ${lastOf(effect.qn)} in ${lastOf(action.qn)}, for example with an Ash notifier or a change`));
    }
    const targets = [...new Set(transitions.map(t => t.data.to as string))];
    if (targets.length === 1) lines.push(`  change transition_state(:${targets[0]})`);
    else if (targets.length > 1) tasks.push(task(`pick the target state of ${lastOf(action.qn)} among ${targets.join(', ')}`));
    lines.push('end');
    if (action.data.consistency === 'eventual') tasks.push(task(`run ${lastOf(action.qn)} with eventual consistency, for example through AshOban`));
    const tests = preconditions.length ? testSteps(action, entity, `action ${snake(lastOf(action.qn))} precondition`, preconditions.map((_, i) => `${i + 1} is enforced`), context) : [];
    return [patch(fileOf(entity, context), existing => addToSection(existing, 'actions', lines)), ...tasks, ...tests];
}

function effectChange(effect: GraphNode, context: MapContext): string | undefined {
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
    const settings = [`initial_states [:${initial}]`, `default_initial_state :${initial}`, `state_attribute :${lastOf(field.qn)}`];
    const lines = transitions.map(t => {
        const action = snake(lastOf((t.data.action ?? t.data.event) as string));
        return `transition :${action}, from: [${(t.data.from as string[]).map(s => `:${s}`).join(', ')}], to: :${t.data.to}`;
    });
    const eventActions = [...byEvent].flatMap(([event, list]) => {
        const targets = [...new Set(list.map(t => t.data.to as string))];
        return targets.length === 1 ? [[`update :${snake(lastOf(event))} do`, '  require_atomic? false', `  change transition_state(:${targets[0]})`, 'end']] : [];
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
    const lines = [
        `trigger :${name} do`,
        `  action :${snake(lastOf(action.qn))}`,
        `  where expr(${where})`,
        `  scheduler_cron ${JSON.stringify(job.data.schedule)}`,
        `  worker_module_name ${module}.AshOban.Worker.${pascal}`,
        `  scheduler_module_name ${module}.AshOban.Scheduler.${pascal}`,
        'end'
    ];
    return [patch(fileOf(entity, context), existing => addToSection(addExtension(existing, 'AshOban'), 'oban', lines, 'triggers'))];
}

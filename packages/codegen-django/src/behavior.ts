import type { MapContext, Step } from '@appling/codegen';
import type { ExprData, GraphNode, TypeData } from '@appling/model';
import { annotation, children, pythonFile, task, template } from './files.js';
import { scope, storedFields } from './models.js';
import { testSteps } from './tests.js';
import { appOf, constantOf, lastOf, parentOf, python, q, snake, type PythonScope } from './python.js';

interface Code {
    lines: string[];
    imports: Set<string>;
    tasks: Step[];
    /** Whether the code changes the instance, so it has to be saved. */
    changes?: boolean;
}

export function errorSteps(error: GraphNode): Step[] {
    return [template(`${appOf(error.module)}/errors.py`, existing => pythonFile(existing ?? ERRORS, [], `class ${lastOf(error.qn)}(Exception):\n    pass`))];
}

const ERRORS = 'class InvalidTransition(Exception):\n    """The state field does not allow this transition."""\n';

export function eventSteps(event: GraphNode): Step[] {
    return [template(`${appOf(event.module)}/events.py`, existing => pythonFile(existing, ['from django.dispatch import Signal'], `${snake(lastOf(event.qn))} = Signal()`))];
}

/** An action becomes a function in `actions.py`: preconditions, state transitions and effects, in one transaction. */
export function actionSteps(action: GraphNode, context: MapContext): Step[] {
    const code: Code = { lines: [], imports: new Set(), tasks: [] };
    const entity = action.data.entity ? context.node(action.data.entity as string) : undefined;
    const instance = entity && snake(lastOf(entity.qn));
    const inputs = children(action, context, 'Param');
    const pyScope: PythonScope = { ...scope(context, code.imports), self: instance, actor: 'actor' };
    if (entity) code.imports.add(`from ${appOf(entity.module)}.models import ${lastOf(entity.qn)}`);

    const preconditions = (action.data.preconditions ?? []) as { condition: ExprData, error?: string }[];
    preconditions.forEach((precondition, i) => {
        const condition = python(precondition.condition, pyScope);
        const text = (action.props.preconditions as string[])[i];
        if (!condition) {
            code.tasks.push(task(`check the precondition ${text}`));
        } else {
            const error = precondition.error ? raiseError(precondition.error, context, code) : `ValueError(${JSON.stringify(text)})`;
            code.lines.push(`if not ${wrap(condition)}:`, `    raise ${error}`);
        }
    });
    const transitions = context.graph.nodes.filter(n => n.kind === 'Transition' && n.data.action === action.qn);
    if (transitions.length && instance) transitionChain(transitions, instance, snake(lastOf(action.qn)), context, pyScope, code);
    for (const effect of children(action, context).filter(c => c.kind.endsWith('Effect'))) effectLines(effect, instance, context, pyScope, code);
    if (instance && code.changes) code.lines.push(`${instance}.save()`);
    if (!code.lines.length) code.tasks.push(task(`implement the action ${lastOf(action.qn)}`));

    const atomic = action.data.consistency !== 'eventual';
    if (atomic) code.imports.add('from django.db import transaction');
    else code.tasks.push(task(`run the effects of ${lastOf(action.qn)} with eventual consistency, for example as a background task`));
    const params = [
        ...(entity ? [`${instance}: ${lastOf(entity.qn)}`] : []),
        '*',
        ...inputs.map(p => {
            const type = p.data.type as TypeData;
            return `${lastOf(p.qn)}: ${annotation(type, context, code.imports)}${type.optional ? ' = None' : ''}`;
        }),
        'actor=None'
    ];
    const body = [
        ...(atomic ? ['@transaction.atomic'] : []),
        `def ${snake(lastOf(action.qn))}(${params.join(', ')}) -> None:`,
        ...(code.lines.length ? code.lines : ['pass']).map(l => `    ${l}`)
    ].join('\n');
    const preconditionTests = preconditions.length ? testSteps(action, (action.props.preconditions as string[]).join('; '), preconditions.map((_, i) => `precondition_${i + 1}_is_enforced`), context) : [];
    return [template(`${appOf(action.module)}/actions.py`, existing => pythonFile(existing, code.imports, body)), ...code.tasks, ...preconditionTests];
}

export function transitionSteps(transition: GraphNode, context: MapContext): Step[] {
    const trigger = lastOf((transition.data.action ?? transition.data.event) as string);
    const rule = `${(transition.data.from as string[]).join(', ')} -> ${transition.data.to} via ${trigger}${transition.props.guard ? ` when ${transition.props.guard}` : ''}`;
    return testSteps(transition, rule, ['moves_from_allowed_states', 'refuses_other_states'], context);
}

/** One branch per transition: the current state and guard pick the branch, anything else is an invalid transition. */
function transitionChain(transitions: GraphNode[], instance: string, label: string, context: MapContext, pyScope: PythonScope, code: Code): void {
    const machine = context.node(parentOf(transitions[0].qn))!;
    const field = context.node(machine.data.field as string)!;
    const enumNode = context.node((field.data.type as TypeData).decl!)!;
    const enumName = lastOf(enumNode.qn);
    const state = `${instance}.${lastOf(field.qn)}`;
    code.imports.add(`from ${appOf(enumNode.module)}.enums import ${enumName}`);
    code.imports.add(`from ${appOf(machine.module)}.errors import InvalidTransition`);
    transitions.forEach((transition, i) => {
        const from = (transition.data.from as string[]).map(s => `${enumName}.${constantOf(s)}`);
        let condition = `${state} in (${from.join(', ')}${from.length === 1 ? ',' : ''})`;
        if (transition.data.guard) {
            const guard = python(transition.data.guard as ExprData, pyScope);
            if (guard) condition += ` and ${wrap(guard)}`;
            else code.tasks.push(task(`check the guard ${transition.props.guard} of ${lastOf(transition.qn)}`));
        }
        code.lines.push(`${i === 0 ? 'if' : 'elif'} ${condition}:`);
        const branch: Code = { lines: [], imports: code.imports, tasks: code.tasks };
        for (const effect of children(transition, context)) effectLines(effect, instance, context, pyScope, branch);
        branch.lines.push(`${state} = ${enumName}.${constantOf(transition.data.to as string)}`);
        code.lines.push(...branch.lines.map(l => `    ${l}`));
    });
    code.changes = true;
    code.lines.push('else:', `    raise InvalidTransition(${JSON.stringify(label)}, ${state})`);
}

function effectLines(effect: GraphNode, instance: string | undefined, context: MapContext, pyScope: PythonScope, code: Code): void {
    const value = (expr: unknown) => python(expr as ExprData, pyScope);
    if (effect.kind === 'SetEffect') {
        const v = value(effect.data.value);
        if (instance && v) {
            code.lines.push(`${instance}.${lastOf(effect.data.field as string)} = ${v}`);
            code.changes = true;
        } else {
            code.tasks.push(task(`apply the effect set ${lastOf(effect.data.field as string)} = ${effect.props.value}`));
        }
        return;
    }
    const assignments = ((effect.data.assignments ?? []) as { name: string, value: ExprData }[]).map(a => [a.name, value(a.value)]);
    const target = context.node((effect.data.entity ?? effect.data.event) as string)!;
    if (assignments.some(([, v]) => !v)) {
        code.tasks.push(task(`apply the effect ${lastOf(effect.qn)}`));
        return;
    }
    const args = assignments.map(([name, v]) => `${name}=${v}`).join(', ');
    if (effect.kind === 'CreateEffect') {
        code.imports.add(`from ${appOf(target.module)}.models import ${lastOf(target.qn)}`);
        code.lines.push(`${lastOf(target.qn)}.objects.create(${args})`);
    } else {
        const signal = snake(lastOf(target.qn));
        code.imports.add(`from ${appOf(target.module)}.events import ${signal}`);
        code.imports.add('from django.db import transaction');
        code.lines.push(`transaction.on_commit(lambda: ${signal}.send(sender=None${args ? `, ${args}` : ''}))`);
    }
}

function raiseError(qn: string, context: MapContext, code: Code): string {
    const error = context.node(qn)!;
    code.imports.add(`from ${appOf(error.module)}.errors import ${lastOf(qn)}`);
    return `${lastOf(qn)}()`;
}

/** Transitions triggered by an event become signal receivers in `handlers.py`, connected when the app is ready. */
export function machineSteps(machine: GraphNode, context: MapContext): Step[] {
    const field = context.node(machine.data.field as string);
    const entity = field && context.node(parentOf(field.qn));
    const byEvent = Map.groupBy(children(machine, context, 'Transition').filter(t => t.data.event), t => t.data.event as string);
    if (!entity || !byEvent.size) return [];
    const steps: Step[] = [];
    for (const [eventQn, transitions] of byEvent) {
        const event = context.node(eventQn)!;
        const carrier = children(event, context, 'Field').find(f => (f.data.type as TypeData).decl === entity.qn);
        if (!carrier) {
            steps.push(task(`apply the transitions of ${lastOf(machine.qn)} on ${lastOf(eventQn)}: the event carries no ${lastOf(entity.qn)}`));
            continue;
        }
        const instance = lastOf(carrier.qn);
        const code: Code = { lines: [], imports: new Set(['from django.dispatch import receiver']), tasks: [] };
        code.imports.add(`from ${appOf(event.module)}.events import ${snake(lastOf(eventQn))}`);
        transitionChain(transitions, instance, snake(lastOf(eventQn)), context, { ...scope(context, code.imports), self: instance }, code);
        code.lines.push(`${instance}.save()`);
        const name = `${snake(lastOf(machine.qn))}_on_${snake(lastOf(eventQn))}`;
        const body = [`@receiver(${snake(lastOf(eventQn))})`, `def ${name}(sender, ${instance}, **kwargs) -> None:`, ...code.lines.map(l => `    ${l}`)].join('\n');
        steps.push(template(`${appOf(machine.module)}/handlers.py`, existing => pythonFile(existing, code.imports, body)), connectHandlers(machine.module), ...code.tasks);
    }
    return steps;
}

/** Imports `handlers.py` when Django starts, so the receivers are connected. */
function connectHandlers(module: string): Step {
    return template(`${appOf(module)}/apps.py`, existing => existing!.includes('def ready(')
        ? existing!
        : `${existing!.trimEnd()}\n\n    def ready(self):\n        from . import handlers  # noqa: F401\n`);
}

/** A scheduled job becomes a Django task and a management command for the scheduler; an event job becomes a receiver. */
export function jobSteps(job: GraphNode, context: MapContext): Step[] {
    const action = context.node(job.data.action as string)!;
    const entity = action.data.entity ? context.node(action.data.entity as string) : undefined;
    const required = children(action, context, 'Param').filter(p => !(p.data.type as TypeData).optional);
    if (!entity || required.length) return [task(`run ${lastOf(action.qn)} from the job ${lastOf(job.qn)}`)];
    const name = snake(lastOf(job.qn));
    const app = appOf(job.module);
    const instance = snake(lastOf(entity.qn));
    const imports = new Set([`from ${appOf(action.module)}.actions import ${snake(lastOf(action.qn))}`, `from ${appOf(entity.module)}.models import ${lastOf(entity.qn)}`]);
    if (job.data.schedule) {
        const filter = job.data.filter ? q(job.data.filter as ExprData, storedFields(entity, context), context.node, scope(context, imports)) : 'models.Q()';
        if (!filter) return [task(`select the rows of ${lastOf(job.qn)} where ${job.props.filter}`)];
        imports.add('from django.db import models');
        imports.add('from django.tasks import task');
        const body = ['@task', `def ${name}() -> None:`, `    for ${instance} in ${lastOf(entity.qn)}.objects.filter(${filter}):`, `        ${snake(lastOf(action.qn))}(${instance})`].join('\n');
        const command = [
            'class Command(BaseCommand):',
            `    help = ${JSON.stringify(`Runs the job ${lastOf(job.qn)}, scheduled as "${job.data.schedule}".`)}`,
            '',
            '    def handle(self, *args, **options):',
            `        ${name}.enqueue()`
        ].join('\n');
        return [
            template(`${app}/jobs.py`, existing => pythonFile(existing, imports, body)),
            template(`${app}/management/__init__.py`, existing => existing ?? ''),
            template(`${app}/management/commands/__init__.py`, existing => existing ?? ''),
            template(`${app}/management/commands/${name}.py`, () => pythonFile(undefined, ['from django.core.management.base import BaseCommand', `from ${app}.jobs import ${name}`], command)),
            task(`schedule "python manage.py ${name}" with cron "${job.data.schedule}"`)
        ];
    }
    const event = context.node(job.data.event as string)!;
    const carrier = children(event, context, 'Field').find(f => (f.data.type as TypeData).decl === entity.qn);
    if (!carrier) return [task(`run ${lastOf(action.qn)} when ${lastOf(event.qn)} happens: the event carries no ${lastOf(entity.qn)}`)];
    const variable = lastOf(carrier.qn);
    const condition = job.data.filter ? python(job.data.filter as ExprData, { ...scope(context, imports), self: variable }) : 'True';
    if (!condition) return [task(`run ${lastOf(action.qn)} when ${lastOf(event.qn)} happens and ${job.props.filter}`)];
    imports.add('from django.dispatch import receiver');
    imports.add(`from ${appOf(event.module)}.events import ${snake(lastOf(event.qn))}`);
    const body = [
        `@receiver(${snake(lastOf(event.qn))})`,
        `def ${name}(sender, ${variable}, **kwargs) -> None:`,
        ...(condition === 'True' ? [`    ${snake(lastOf(action.qn))}(${variable})`] : [`    if ${condition}:`, `        ${snake(lastOf(action.qn))}(${variable})`])
    ].join('\n');
    return [template(`${app}/handlers.py`, existing => pythonFile(existing, imports, body)), connectHandlers(job.module)];
}

export function wrap(code: string): string {
    return /^[\w.]+(\(.*\))?$/.test(code) ? code : `(${code})`;
}

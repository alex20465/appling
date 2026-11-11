import type { MapContext, Step } from '@appling/codegen';
import { durationMs, Simulator, UNKNOWN, type ExprData, type GraphNode, type Record as SimRecord, type TypeData, type Value } from '@appling/model';
import { children } from './files.js';
import { factory, holds, sample, simulator } from './fixtures.js';
import { appOf, constantOf, duration, lastOf, parentOf, python, snake } from './python.js';
import { testSteps, type TestCase } from './tests.js';

/** The rows and inputs a test runs an action with, as Python and as the simulator sees them. */
export interface Setup {
    entity?: GraphNode;
    instance?: string;
    record?: SimRecord;
    /** The keyword arguments of the action call, such as `reason="x"`. */
    args: string[];
    inputs: { [name: string]: Value };
    imports: Set<string>;
    steps: Step[];
}

/**
 * The factory of the action's entity and a sample for every required input; undefined when a fixture is missing.
 * A use case takes the same inputs and is imported from `usecases`.
 */
export function setup(action: GraphNode, context: MapContext): Setup | undefined {
    const file = action.kind === 'UseCase' ? 'usecases' : 'actions';
    const imports = new Set<string>([`from ${appOf(action.module)}.${file} import ${snake(lastOf(action.qn))}`]);
    const steps: Step[] = [];
    const result: Setup = { args: [], inputs: {}, imports, steps };
    if (action.data.entity) {
        const entity = context.node(action.data.entity as string)!;
        const made = factory(entity, context);
        if (!made) return undefined;
        imports.add(made.import);
        steps.push(...made.steps);
        Object.assign(result, { entity, instance: snake(lastOf(entity.qn)), record: made.record });
    }
    for (const param of children(action, context, 'Param')) {
        const type = param.data.type as TypeData;
        const name = lastOf(param.qn);
        if (type.optional) {
            result.inputs[name] = null;
            continue;
        }
        if (type.many) return undefined;
        const decl = type.decl ? context.node(type.decl) : undefined;
        if (decl?.kind === 'Entity') {
            const made = factory(decl, context);
            if (!made) return undefined;
            imports.add(made.import);
            steps.push(...made.steps);
            result.args.push(`${name}=${made.name}()`);
            result.inputs[name] = made.record;
            continue;
        }
        const text = type.primitive === 'String' || type.primitive === 'Text';
        const value = text ? { python: JSON.stringify(name), value: UNKNOWN } : sample(name, type, false, context, imports);
        if (!value) return undefined;
        result.args.push(`${name}=${value.python}`);
        result.inputs[name] = value.value;
    }
    return result;
}

/** The call of the action in a test, with extra keyword arguments such as `actor=user`. */
export function call(action: GraphNode, run: Setup, extra: string[] = []): string {
    return `${snake(lastOf(action.qn))}(${[...(run.instance ? [run.instance] : []), ...run.args, ...extra].join(', ')})`;
}

/** Whether every invariant of the entity holds for the record. */
export function valid(entity: GraphNode | undefined, record: SimRecord | undefined, context: MapContext): boolean {
    return !entity || children(entity, context, 'Invariant').every(i => holds(i.data.condition as ExprData, context, record));
}

/** The record after the effects, or undefined when an effect creates, changes or deletes other rows or depends on something the test does not know. */
export function afterEffects(effects: GraphNode[], record: SimRecord, inputs: { [name: string]: Value }, context: MapContext): SimRecord | undefined {
    const after: SimRecord = { ...record };
    for (const effect of effects) {
        if (['CreateEffect', 'ForEffect', 'UpdateEffect', 'DeleteEffect'].includes(effect.kind)) return undefined;
        if (effect.kind === 'SetEffect') {
            const value = simulator(context).evaluate(effect.data.value as ExprData, { self: after, inputs });
            if (value === UNKNOWN) return undefined;
            after[lastOf(effect.data.field as string)] = value;
        } else if (((effect.data.assignments ?? []) as { value: ExprData }[]).some(a => simulator(context).evaluate(a.value, { self: after, inputs }) === UNKNOWN)) {
            return undefined;
        }
    }
    return after;
}

/** Whether the action's preconditions are all translated to Python and all hold. */
export function preconditionsHold(action: GraphNode, record: SimRecord | undefined, inputs: { [name: string]: Value }, context: MapContext): boolean {
    return ((action.data.preconditions ?? []) as { condition: ExprData }[]).every(p => translated(p.condition, context) && holds(p.condition, context, record, inputs));
}

function translated(expr: ExprData, context: MapContext): boolean {
    return python(expr, { node: context.node, imports: new Set(), self: 'row', actor: 'actor' }) !== undefined;
}

function tuple(items: string[]): string {
    return `(${items.join(', ')}${items.length === 1 ? ',' : ''})`;
}

/**
 * The tests of a transition: the entity is created in each allowed state, the action runs (or the event is
 * sent) and the state must be `to`; in a state no transition of that trigger leaves, it must raise
 * `InvalidTransition`. A state only counts when the simulator proves the fixture passes the preconditions,
 * the guard and the invariants; without such a state the case stays a registry task.
 */
export function transitionTests(transition: GraphNode, rule: string, context: MapContext): Step[] {
    const cases = ['moves_from_allowed_states', 'refuses_other_states'];
    const machine = context.node(parentOf(transition.qn))!;
    const field = context.node(machine.data.field as string);
    const enumNode = field && (field.data.type as TypeData).decl ? context.node((field.data.type as TypeData).decl!) : undefined;
    if (!field || enumNode?.kind !== 'Enum') return testSteps(transition, rule, cases, context);
    const stateField = lastOf(field.qn);
    const enumName = lastOf(enumNode.qn);
    const literals = context.children(enumNode.qn).map(l => lastOf(l.qn));
    const constant = (state: string) => `${enumName}.${constantOf(state)}`;
    const trigger = transition.data.action ? context.node(transition.data.action as string)! : undefined;
    const event = transition.data.event ? context.node(transition.data.event as string)! : undefined;
    const siblings = context.graph.nodes.filter(n => n.kind === 'Transition' && (trigger ? n.data.action === trigger.qn : n.data.event === event!.qn && parentOf(n.qn) === machine.qn));

    let run: Setup | undefined;
    let fire: ((instance: string) => string) | undefined;
    const imports = new Set([`from ${appOf(enumNode.module)}.enums import ${enumName}`, `from ${appOf(machine.module)}.errors import InvalidTransition`]);
    if (trigger) {
        run = setup(trigger, context);
        if (run?.entity?.qn !== parentOf(field.qn)) run = undefined;
        if (run) fire = () => call(trigger, run!);
    } else if (event) {
        const entity = context.node(parentOf(field.qn))!;
        const carrier = children(event, context, 'Field').find(f => (f.data.type as TypeData).decl === entity.qn);
        const others = context.graph.nodes.some(n => (n.kind === 'Job' && n.data.event === event.qn) || (n.kind === 'Transition' && n.data.event === event.qn && parentOf(n.qn) !== machine.qn));
        const made = factory(entity, context);
        if (carrier && !others && made) {
            const signal = snake(lastOf(event.qn));
            run = { entity, instance: snake(lastOf(entity.qn)), record: made.record, args: [], inputs: {}, imports: new Set([made.import, `from ${appOf(event.module)}.events import ${signal}`]), steps: made.steps };
            fire = instance => `${signal}.send(sender=None, ${lastOf(carrier.qn)}=${instance})`;
        }
    }
    if (!run || !fire) return testSteps(transition, rule, cases, context);
    for (const line of run.imports) imports.add(line);
    const make = `${run.instance} = make_${run.instance}(${stateField}=state)`;
    const before = (state: string): SimRecord => ({ ...run!.record, [stateField]: state });
    const ready = (state: string) => valid(run!.entity, before(state), context) && (!trigger || preconditionsHold(trigger, before(state), run!.inputs, context));

    const index = siblings.indexOf(transition);
    const moving = (transition.data.from as string[]).filter(state => {
        if (siblings.slice(0, index).some(s => (s.data.from as string[]).includes(state))) return false;
        if (!ready(state)) return false;
        if (transition.data.guard && !(translated(transition.data.guard as ExprData, context) && holds(transition.data.guard as ExprData, context, before(state), run!.inputs))) return false;
        const effects = [...children(transition, context), ...(trigger ? children(trigger, context).filter(c => c.kind.endsWith('Effect')) : [])];
        const after = afterEffects(effects, before(state), run!.inputs, context);
        return after !== undefined && valid(run!.entity, { ...after, [stateField]: transition.data.to as string }, context);
    });
    const left = new Set(siblings.flatMap(s => s.data.from as string[]));
    const others = literals.filter(state => !left.has(state));
    const refusing = others.filter(ready);
    const loop = (states: string[], body: string[]) => [
        `for state in ${tuple(states.map(constant))}:`,
        '    with self.subTest(state=state):',
        `        ${make}`,
        ...body.map(l => `        ${l}`)
    ];
    const tests: TestCase[] = [
        moving.length
            ? { name: cases[0], body: loop(moving, [fire(run.instance!), `${run.instance}.refresh_from_db()`, `self.assertEqual(${run.instance}.${stateField}, ${constant(transition.data.to as string)})`]) }
            : { name: cases[0] },
        ...(others.length ? [refusing.length === others.length
            ? { name: cases[1], body: loop(refusing, ['with self.assertRaises(InvalidTransition):', `    ${fire(run.instance!)}`]) }
            : { name: cases[1] }] : [])
    ];
    if (tests.every(t => !t.body)) return testSteps(transition, rule, tests, context);
    return testSteps(transition, rule, tests, context, imports, run.steps);
}

/** The name of a machine's sweep over its timed transitions: the task in `jobs.py` and the management command. */
export function timeoutName(machine: GraphNode): string {
    return `${snake(lastOf(machine.qn))}_timeouts`;
}

/**
 * The tests of a timed transition (`after … since …`): a row in each from state whose date lies a minute more
 * than the duration back must be in `to` after the sweep ran, and a row whose date is now must stay. A state
 * only counts when the simulator, its clock moved past the duration, takes this transition with nothing left
 * undecided and the invariants holding afterwards; without such a state the case stays a registry task.
 */
export function timedTransitionTests(transition: GraphNode, context: MapContext): Step[] {
    const machine = context.node(parentOf(transition.qn))!;
    const field = context.node(machine.data.field as string)!;
    const since = lastOf(transition.data.since as string);
    const rule = `${(transition.data.from as string[]).join(', ')} -> ${transition.data.to} after ${transition.data.after} since ${since}${transition.props.guard ? ` when ${transition.props.guard}` : ''}`;
    const cases = ['moves_once_due', 'waits_until_due'];
    const enumNode = context.node((field.data.type as TypeData).decl!)!;
    const entity = context.node(parentOf(field.qn))!;
    const made = factory(entity, context);
    const imports = new Set<string>();
    const delta = duration(String(transition.data.after), { imports });
    const guard = transition.data.guard as ExprData | undefined;
    if (!made || !delta || (guard && !translated(guard, context))) return testSteps(transition, rule, cases, context);
    const stateField = lastOf(field.qn);
    const enumName = lastOf(enumNode.qn);
    const instance = snake(lastOf(entity.qn));
    const constant = (state: string) => `${enumName}.${constantOf(state)}`;
    const date = (context.node(transition.data.since as string)!.data.type as TypeData).primitive === 'Date';
    const now = new Date();
    const due = new Date(now.getTime() - durationMs(String(transition.data.after)) - (date ? 86_400_000 : 60_000));
    const later = new Simulator(context.graph, now);
    const moving = (transition.data.from as string[]).filter(state => {
        const result = later.elapse(machine.qn, { ...made.record, [stateField]: state, [since]: due });
        return result?.transition === transition.qn && !result.undecided.length && !result.violated.length && !result.writes.length && !result.events.length;
    });
    if (!moving.length) return testSteps(transition, rule, cases, context);
    const sweep = timeoutName(machine);
    for (const line of [made.import, `from ${appOf(enumNode.module)}.enums import ${enumName}`, `from ${appOf(machine.module)}.jobs import ${sweep}`, 'from django.utils import timezone']) imports.add(line);
    const start = date ? 'timezone.localdate()' : 'timezone.now()';
    const back = `${start} - ${delta} - timedelta(${date ? 'days' : 'minutes'}=1)`;
    const loop = (when: string, expected: (state: string) => string) => [
        `for state in ${tuple(moving.map(constant))}:`,
        '    with self.subTest(state=state):',
        `        ${instance} = make_${instance}(${stateField}=state, ${since}=${when})`,
        `        ${sweep}.call()`,
        `        ${instance}.refresh_from_db()`,
        `        self.assertEqual(${instance}.${stateField}, ${expected('state')})`
    ];
    const tests: TestCase[] = [
        { name: cases[0], body: loop(back, () => constant(transition.data.to as string)) },
        { name: cases[1], body: loop(start, state => state) }
    ];
    return testSteps(transition, rule, tests, context, imports, made.steps);
}

/**
 * The tests of an action's preconditions: for each, a row and inputs for which the simulator proves the earlier
 * preconditions hold and this one fails, then the action must raise the declared error (or `ValueError`).
 */
export function preconditionTests(action: GraphNode, context: MapContext): Step[] {
    const preconditions = (action.data.preconditions ?? []) as { condition: ExprData, error?: string }[];
    const rule = (action.props.preconditions as string[]).join('; ');
    const names = preconditions.map((_, i) => `precondition_${i + 1}_is_enforced`);
    const run = setup(action, context);
    if (!run || !valid(run.entity, run.record, context)) return testSteps(action, rule, names, context);
    const imports = new Set(run.imports);
    const tests: TestCase[] = preconditions.map((precondition, i) => {
        const earlier = preconditions.slice(0, i).every(p => holds(p.condition, context, run.record, run.inputs));
        const fails = simulator(context).evaluate(precondition.condition, { self: run.record, inputs: run.inputs }) === false;
        if (!earlier || !fails || !translated(precondition.condition, context)) return { name: names[i] };
        let error = 'ValueError';
        if (precondition.error) {
            error = lastOf(precondition.error);
            imports.add(`from ${appOf(context.node(precondition.error)!.module)}.errors import ${error}`);
        }
        return {
            name: names[i],
            body: [
                ...(run.instance ? [`${run.instance} = make_${run.instance}()`] : []),
                `with self.assertRaises(${error}):`,
                `    ${call(action, run)}`
            ]
        };
    });
    if (tests.every(t => !t.body)) return testSteps(action, rule, tests, context);
    return testSteps(action, rule, tests, context, imports, run.steps);
}

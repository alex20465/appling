import type { MapContext, Step } from '@appling/codegen';
import { Simulator, UNKNOWN, type ExprData, type Graph, type GraphNode, type Record as SimRecord, type TypeData, type Value } from '@appling/model';
import { homeAt } from './actors.js';
import { constant, lastOf, parentOf, validation } from './elixir.js';
import { fieldsOf, relationTarget, snake, storedAttributes, timedAction, typeModule } from './naming.js';
import { testSteps, type TestCase } from './tests.js';

/** A value a test may give an attribute, as Elixir and as the simulator sees it (UNKNOWN when the test must not rely on it). */
interface Sample {
    elixir: string;
    value: Value;
}

const simulators = new WeakMap<Graph, Simulator>();

/** One simulator per graph, used to prove what a test may rely on. */
export function simulator(context: MapContext): Simulator {
    let found = simulators.get(context.graph);
    if (!found) simulators.set(context.graph, found = new Simulator(context.graph));
    return found;
}

/** The invariant as one of Ash's builtin validations, or undefined when it does not translate. */
export function check(invariant: GraphNode, context: MapContext): string | undefined {
    return validation(invariant.data.condition as ExprData, storedAttributes(context.node(parentOf(invariant.qn))!, context), context.node);
}

/** A field's default as an Elixir attribute default, or undefined when it has none that translates. */
export function defaultValue(field: GraphNode, context: MapContext): string | undefined {
    const expr = field.data.default as ExprData | undefined;
    if (!expr) return undefined;
    if (expr.$type === 'NameExpr' && expr.name === 'now' && !expr.target) return '&DateTime.utc_now/0';
    return constant(expr, context.node);
}

/**
 * The tests of an invariant enforced as a validation. They build a changeset for the resource's `create`
 * action, which runs the validations without a database: the sample input must be valid, and an input whose
 * one attribute the simulator proves to break this invariant (and no other validation) must not. Without a
 * sample input or without such an attribute value, a case stays a registry task.
 */
export function invariantTests(invariant: GraphNode, context: MapContext): Step[] {
    const entity = context.node(parentOf(invariant.qn))!;
    const title = `invariant ${invariant.data.label}`;
    const cases = ['holds for valid records', 'rejects violations'];
    const input = check(invariant, context) ? sampleInput(entity, context) : undefined;
    if (!input) return testSteps(invariant, entity, title, cases, context);
    const resource = typeModule(entity, context);
    const changeset = (attributes: [string, string][]) =>
        `changeset = Ash.Changeset.for_create(${resource}, :create, %{${attributes.map(([n, v]) => `${n}: ${v}`).join(', ')}}, authorize?: false)`;
    const violation = violating(invariant, entity, input.record, context);
    const tests: TestCase[] = [
        { name: cases[0], body: [changeset(input.attributes), 'assert changeset.valid?'] },
        {
            name: cases[1],
            body: violation && [changeset([...input.attributes.filter(([n]) => n !== violation[0]), violation]), 'refute changeset.valid?']
        }
    ];
    return testSteps(invariant, entity, title, tests, context);
}

/**
 * An input for the `create` action that every translated invariant accepts: a sample value for every required
 * stored attribute without a default. Undefined when the model does not say enough, such as a required
 * relationship, a value type, a file, a default that does not translate, or an actor resource.
 */
function sampleInput(entity: GraphNode, context: MapContext): { attributes: [string, string][], defaults: [string, string][], record: SimRecord } | undefined {
    if (homeAt(entity, context)) return undefined;
    const record: SimRecord = { $type: entity.qn };
    const attributes: [string, string][] = [];
    const defaults: [string, string][] = [];
    for (const field of fieldsOf(entity, context)) {
        const type = field.data.type as TypeData;
        const name = lastOf(field.qn);
        if (field.data.derived) continue;
        if (relationTarget(field, context)) {
            if (!type.optional && !type.many) return undefined;
            continue;
        }
        if (type.many) {
            record[name] = [];
            continue;
        }
        if (field.data.default) {
            const value = defaultValue(field, context);
            if (value === undefined) return undefined;
            defaults.push([name, value === '&DateTime.utc_now/0' ? 'DateTime.utc_now()' : value]);
            record[name] = simulator(context).evaluate(field.data.default as ExprData, { self: record });
            continue;
        }
        if (type.optional) {
            record[name] = null;
            continue;
        }
        const value = sample(name, type, context);
        if (!value) return undefined;
        attributes.push([name, value.elixir]);
        record[name] = value.value;
    }
    if (!enforcedInvariants(entity, context).every(i => holds(i, context, record))) return undefined;
    return { attributes, defaults, record };
}

/**
 * An attribute and a value for which the invariant is false and every other translated invariant true. The
 * attributes the condition compares must stay non nil, since Ash's `compare` and `attribute_*` validations
 * pass on nil.
 */
function violating(invariant: GraphNode, entity: GraphNode, record: SimRecord, context: MapContext): [string, string] | undefined {
    const condition = invariant.data.condition as ExprData;
    const read = targets(condition);
    const fields = fieldsOf(entity, context).filter(f => read.has(f.qn) && !f.data.derived && !relationTarget(f, context) && !(f.data.type as TypeData).many);
    const others = enforcedInvariants(entity, context).filter(i => i.qn !== invariant.qn);
    for (const field of fields) {
        const name = lastOf(field.qn);
        for (const candidate of candidates(field.data.type as TypeData, context)) {
            const row = { ...record, [name]: candidate.value };
            if (fields.some(f => row[lastOf(f.qn)] === null || row[lastOf(f.qn)] === undefined)) continue;
            if (simulator(context).evaluate(condition, { self: row }) !== false) continue;
            if (!others.every(i => holds(i, context, row))) continue;
            return [name, candidate.elixir];
        }
    }
    return undefined;
}

/**
 * The tests of a transition. They build a changeset for the update action AshStateMachine runs it with, on a
 * record struct built from the sample input, which runs the transition check without a database: from an
 * allowed state the changeset must be valid, from a state no transition of that action leaves it must carry
 * AshStateMachine's NoMatchingTransition error. The first case needs the simulator to prove the action's
 * preconditions and guards true and the entity's translated invariants true after the transition, with no
 * effect changing a field they read. Without a single target state for the action, a sample input or sample
 * values for its required arguments, a case stays a registry task.
 */
export function transitionTests(transition: GraphNode, context: MapContext): Step[] {
    const machine = context.node(parentOf(transition.qn))!;
    const stateField = context.node(machine.data.field as string)!;
    const entity = context.node(parentOf(stateField.qn))!;
    const title = `transition ${(transition.data.from as string[]).join(', ')} -> ${transition.data.to}`;
    const cases = ['moves from allowed states', 'refuses other states'];
    const plan = transitionPlan(transition, entity, context);
    const input = plan && sampleInput(entity, context);
    if (!plan || !input) return testSteps(transition, entity, title, cases, context);
    const state = lastOf(stateField.qn);
    const resource = typeModule(entity, context);
    const pairs = (values: [string, string][]) => values.map(([n, v]) => `${n}: ${v}`).join(', ');
    const changeset = (from: string) => [
        `record = struct!(${resource}, %{${pairs([...input.attributes, ...input.defaults.filter(([n]) => n !== state), [state, `:${from}`]])}})`,
        `changeset = Ash.Changeset.for_update(record, :${plan.action}, %{${pairs(plan.arguments)}}, authorize?: false)`
    ];
    const literals = context.children((stateField.data.type as TypeData).decl!).map(l => lastOf(l.qn));
    const allowed = new Set(plan.transitions.flatMap(t => t.data.from as string[]));
    const other = literals.find(l => !allowed.has(l));
    const from = (transition.data.from as string[]).find(f => movesFrom(f, transition, plan, entity, input.record, state, context));
    const tests: TestCase[] = [
        { name: cases[0], body: from ? [...changeset(from), 'assert changeset.valid?'] : undefined },
        {
            name: cases[1],
            body: other ? [...changeset(other), 'refute changeset.valid?', 'assert Enum.any?(changeset.errors, &match?(%AshStateMachine.Errors.NoMatchingTransition{}, &1))'] : undefined
        }
    ];
    return testSteps(transition, entity, title, tests, context);
}

/**
 * The tests of an action's preconditions. Each builds a changeset for the action's update action on a record
 * struct from the sample input, in the first state the action's transitions leave, which runs the precondition
 * validations without a database. A case gets a body when the precondition translates to a validation, the
 * simulator proves the earlier preconditions true and this one false on that record, and every attribute the
 * condition compares is set (Ash's `compare` and `attribute_*` validations pass on nil); the changeset must
 * then be invalid with the precondition's message. Without a sample input or sample values for the action's
 * required arguments every case stays a registry task.
 */
export function preconditionTests(action: GraphNode, entity: GraphNode, context: MapContext): Step[] {
    const preconditions = (action.data.preconditions ?? []) as { condition: ExprData, error?: string }[];
    const texts = action.props.preconditions as string[];
    const title = `action ${snake(lastOf(action.qn))} precondition`;
    const cases = preconditions.map((_, i) => `${i + 1} is enforced`);
    const args = requiredArguments(action, context);
    const input = args && sampleInput(entity, context);
    if (!args || !input) return testSteps(action, entity, title, cases, context);
    const transition = context.graph.nodes.find(n => n.kind === 'Transition' && n.data.action === action.qn);
    const stateField = transition && context.node(context.node(parentOf(transition.qn))!.data.field as string);
    const state = stateField && parentOf(stateField.qn) === entity.qn ? lastOf(stateField.qn) : undefined;
    const from = state ? (transition!.data.from as string[])[0] : undefined;
    const record: SimRecord = state ? { ...input.record, [state]: from! } : input.record;
    const values: [string, string][] = [...input.attributes, ...input.defaults.filter(([n]) => n !== state), ...(state ? [[state, `:${from}`] as [string, string]] : [])];
    const resource = typeModule(entity, context);
    const pairs = (list: [string, string][]) => list.map(([n, v]) => `${n}: ${v}`).join(', ');
    const stored = storedAttributes(entity, context);
    const tests: TestCase[] = preconditions.map((precondition, i) => {
        const earlier = preconditions.slice(0, i).every(p => simulator(context).evaluate(p.condition, { self: record }) === true);
        const fails = simulator(context).evaluate(precondition.condition, { self: record }) === false;
        const set = [...targets(precondition.condition)].every(qn => record[lastOf(qn)] !== null && record[lastOf(qn)] !== undefined);
        if (!earlier || !fails || !set || !validation(precondition.condition, stored, context.node)) return { name: cases[i] };
        const message = precondition.error ? lastOf(precondition.error) : texts[i];
        return {
            name: cases[i],
            body: [
                `record = struct!(${resource}, %{${pairs(values)}})`,
                `changeset = Ash.Changeset.for_update(record, :${snake(lastOf(action.qn))}, %{${pairs(args)}}, authorize?: false)`,
                'refute changeset.valid?',
                `assert Enum.any?(changeset.errors, &(Map.get(&1, :message) == ${JSON.stringify(message)}))`
            ]
        };
    });
    return testSteps(action, entity, title, tests, context);
}

/** Sample values for an action's required arguments, or undefined when one has none. */
function requiredArguments(action: GraphNode, context: MapContext): [string, string][] | undefined {
    const args: [string, string][] = [];
    for (const param of context.children(action.qn).filter(c => c.kind === 'Param')) {
        const type = param.data.type as TypeData;
        if (type.optional) continue;
        const value = type.many ? { elixir: '[]' } : sample(lastOf(param.qn), type, context);
        if (!value) return undefined;
        args.push([lastOf(param.qn), value.elixir]);
    }
    return args;
}

interface TransitionPlan {
    /** The update action AshStateMachine runs the transition with. */
    action: string;
    /** Every transition of that action; they share one target state. */
    transitions: GraphNode[];
    /** The action node, for a transition bound to an action. */
    node?: GraphNode;
    /** Sample values for the action's required arguments. */
    arguments: [string, string][];
}

/** The update action the generator writes for the transition, or undefined when it writes none with transition_state. */
function transitionPlan(transition: GraphNode, entity: GraphNode, context: MapContext): TransitionPlan | undefined {
    const action = transition.data.action as string | undefined;
    const event = transition.data.event as string | undefined;
    if (transition.data.after !== undefined) return { action: timedAction(transition), transitions: [transition], arguments: [] };
    if (!action && !event) return undefined;
    // An action's update action is written once for every transition it drives, an event's per machine.
    const transitions = action
        ? context.graph.nodes.filter(n => n.kind === 'Transition' && n.data.action === action)
        : context.children(parentOf(transition.qn)).filter(n => n.kind === 'Transition' && n.data.event === event);
    if (new Set(transitions.map(t => t.data.to)).size !== 1) return undefined;
    if (!action) return { action: snake(lastOf(event!)), transitions, arguments: [] };
    const node = context.node(action)!;
    if (node.data.entity !== entity.qn) return undefined;
    const args = requiredArguments(node, context);
    if (!args) return undefined;
    return { action: snake(lastOf(action)), transitions, node, arguments: args };
}

/** Whether the simulator proves the action's changeset valid on the sample record in the given state. */
function movesFrom(from: string, transition: GraphNode, plan: TransitionPlan, entity: GraphNode, record: SimRecord, state: string, context: MapContext): boolean {
    const before: SimRecord = { ...record, [state]: from };
    const conditions = [
        ...((plan.node?.data.preconditions ?? []) as { condition: ExprData }[]).map(p => p.condition),
        ...plan.transitions.filter(t => t.data.guard).map(t => t.data.guard as ExprData)
    ];
    if (!conditions.every(c => simulator(context).evaluate(c, { self: before }) === true)) return false;
    const invariants = enforcedInvariants(entity, context);
    const read = new Set(invariants.flatMap(i => [...targets(i.data.condition)]));
    const effects = [...(plan.node ? context.children(plan.node.qn) : []), ...context.children(transition.qn)].filter(c => c.kind === 'SetEffect');
    if (effects.some(e => read.has(e.data.field as string))) return false;
    const after: SimRecord = { ...before, [state]: transition.data.to as string };
    return invariants.every(i => holds(i, context, after));
}

export function enforcedInvariants(entity: GraphNode, context: MapContext): GraphNode[] {
    return context.children(entity.qn).filter(n => n.kind === 'Invariant' && check(n, context));
}

export function holds(invariant: GraphNode, context: MapContext, self: SimRecord): boolean {
    return simulator(context).evaluate(invariant.data.condition as ExprData, { self }) === true;
}

/** A sample value of a required attribute without a default; undefined when there is none, such as for a file. */
export function sample(name: string, type: TypeData, context: MapContext): Sample | undefined {
    if (type.decl) {
        const decl = context.node(type.decl)!;
        const first = decl.kind === 'Enum' ? context.children(decl.qn)[0] : undefined;
        return first && { elixir: `:${lastOf(first.qn)}`, value: lastOf(first.qn) };
    }
    switch (type.primitive) {
        case 'String':
        case 'Text': return { elixir: JSON.stringify(`${name}-1`), value: UNKNOWN };
        case 'Int': return { elixir: '1', value: 1 };
        case 'Decimal':
        case 'Money': return { elixir: 'Decimal.new("1")', value: 1 };
        case 'Bool': return { elixir: 'false', value: false };
        case 'Date': return { elixir: 'Date.utc_today()', value: UNKNOWN };
        case 'DateTime': return { elixir: 'DateTime.utc_now()', value: UNKNOWN };
        case 'Duration': return { elixir: 'Duration.new!(hour: 1)', value: 3_600_000 };
        case 'Uuid': return { elixir: 'Ash.UUID.generate()', value: UNKNOWN };
    }
    return undefined;
}

/** The values tried on an attribute: a few numbers, both booleans, every enum literal; none for other types. */
function candidates(type: TypeData, context: MapContext): Sample[] {
    if (type.decl) {
        const decl = context.node(type.decl);
        return decl?.kind === 'Enum' ? context.children(decl.qn).map(l => ({ elixir: `:${lastOf(l.qn)}`, value: lastOf(l.qn) })) : [];
    }
    const numbers = [-1, 0, 1_000_000];
    switch (type.primitive) {
        case 'Int': return numbers.map(n => ({ elixir: String(n), value: n }));
        case 'Decimal':
        case 'Money': return numbers.map(n => ({ elixir: `Decimal.new("${n}")`, value: n }));
        case 'Bool': return [{ elixir: 'true', value: true }, { elixir: 'false', value: false }];
    }
    return [];
}

/** The qualified names the expression compares; a name only tested by `has()` is left out, its nil is meant. */
export function targets(expr: unknown, found: Set<string> = new Set()): Set<string> {
    if (Array.isArray(expr)) {
        for (const item of expr) targets(item, found);
    } else if (expr && typeof expr === 'object') {
        const node = expr as { $type?: string, target?: unknown, call?: unknown, name?: unknown };
        if (node.$type === 'NameExpr' && node.call && node.name === 'has') return found;
        if (node.$type === 'NameExpr' && typeof node.target === 'string') found.add(node.target);
        for (const value of Object.values(expr)) targets(value, found);
    }
    return found;
}

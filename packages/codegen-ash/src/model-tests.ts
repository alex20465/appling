import type { MapContext, Step } from '@appling/codegen';
import { Simulator, UNKNOWN, type ExprData, type Graph, type GraphNode, type Record as SimRecord, type TypeData, type Value } from '@appling/model';
import { homeAt } from './actors.js';
import { constant, lastOf, parentOf, validation } from './elixir.js';
import { fieldsOf, relationTarget, storedAttributes, typeModule } from './naming.js';
import { testSteps, type TestCase } from './tests.js';

/** A value a test may give an attribute, as Elixir and as the simulator sees it (UNKNOWN when the test must not rely on it). */
interface Sample {
    elixir: string;
    value: Value;
}

const simulators = new WeakMap<Graph, Simulator>();

function simulator(context: MapContext): Simulator {
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
function sampleInput(entity: GraphNode, context: MapContext): { attributes: [string, string][], record: SimRecord } | undefined {
    if (homeAt(entity, context)) return undefined;
    const record: SimRecord = { $type: entity.qn };
    const attributes: [string, string][] = [];
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
            if (defaultValue(field, context) === undefined) return undefined;
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
    return { attributes, record };
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

function enforcedInvariants(entity: GraphNode, context: MapContext): GraphNode[] {
    return context.children(entity.qn).filter(n => n.kind === 'Invariant' && check(n, context));
}

function holds(invariant: GraphNode, context: MapContext, self: SimRecord): boolean {
    return simulator(context).evaluate(invariant.data.condition as ExprData, { self }) === true;
}

/** A sample value of a required attribute without a default; undefined when there is none, such as for a file. */
function sample(name: string, type: TypeData, context: MapContext): Sample | undefined {
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
function targets(expr: unknown, found: Set<string> = new Set()): Set<string> {
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

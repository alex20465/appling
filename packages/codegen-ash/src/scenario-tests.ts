import type { MapContext, Step } from '@appling/codegen';
import { coveredByScenarios, scenarioCall, UNKNOWN, type ExprData, type Graph, type GraphNode, type Record as SimRecord, type TypeData, type Value } from '@appling/model';
import { homeAt, homeFields, homeOf, type ActorHome } from './actors.js';
import { effectChange } from './behavior.js';
import { elixirString, lastOf, parentOf, validation } from './elixir.js';
import { defaultValue, enforcedInvariants, sample, simulator, targets } from './model-tests.js';
import { app, calculation, children, fieldsOf, moduleName, pascal, relationTarget, snake, storedAttributes, task, typeModule } from './naming.js';
import { checksAnswer, enforced, policyTranslates } from './roles.js';
import { partitionOf } from './tenants.js';

const covered = new WeakMap<Graph, Set<string>>();

/** Whether a scenario's `when` runs this action or use case, or the action that triggers this transition: its guessed tests give way to the scenario test. */
export function coveredByScenario(qn: string, context: MapContext): boolean {
    let found = covered.get(context.graph);
    if (!found) covered.set(context.graph, found = coveredByScenarios(context.graph));
    return found.has(qn);
}

/**
 * A scenario becomes an ExUnit test in `test/<app>/<module>/scenarios_test.exs`, which checks out a database
 * sandbox: the given rows are written with `Ash.Seed.seed!` (their values, samples for the other required
 * attributes), the actor is a record of its resource or its struct with the actor's roles, the call runs the
 * action's update action with `Ash.update`, and the test asserts the outcome and reads the rows back for the
 * checks. A scenario whose test the generated project cannot pass yet stays a skipped test and a registry task
 * that says why.
 */
export function scenarioSteps(scenario: GraphNode, context: MapContext): Step[] {
    const file = ['test', app(context), ...scenario.module.split('.').map(snake), 'scenarios_test.exs'].join('/');
    const title = `scenario ${lastOf(scenario.qn)}`;
    let body: string[] | undefined;
    let why = '';
    try {
        body = scenarioBody(scenario, context);
    } catch (error) {
        if (!(error instanceof Unsupported)) throw error;
        why = error.message;
    }
    const does = typeof scenario.data.does === 'string' && scenario.data.does.trim() ? `  # ${scenario.data.does.trim().replace(/\s*\n\s*/g, ' ')}\n` : '';
    const test = body
        ? `${does}  test ${JSON.stringify(title)} do\n${body.map(l => `    ${l}\n`).join('')}  end\n`
        : `${does}  @tag skip: ${JSON.stringify(`registry task: ${scenario.qn}`)}\n  test ${JSON.stringify(title)}\n`;
    const repo = `${pascal(app(context))}.Repo`;
    return [
        {
            kind: 'template', file, write: existing => existing
                ? existing.replace(/end\n?$/, `\n${test}end\n`)
                : [
                    `defmodule ${moduleName(scenario.module, context)}.ScenariosTest do`,
                    '  use ExUnit.Case, async: false',
                    '',
                    '  setup do',
                    `    pid = Ecto.Adapters.SQL.Sandbox.start_owner!(${repo}, shared: true)`,
                    '    on_exit(fn -> Ecto.Adapters.SQL.Sandbox.stop_owner(pid) end)',
                    '    :ok',
                    '  end',
                    '',
                    `${test}end`,
                    ''
                ].join('\n')
        },
        ...(body ? [] : [task(`write the test "${title}" in ${file}: ${why}`)])
    ];
}

/** Why a scenario's test cannot be written yet. */
class Unsupported extends Error {}

function fail(why: string): never {
    throw new Unsupported(why);
}

/** A given row: its Elixir variable, its entity, the row as the simulator sees it before the call, and its tenant. */
interface Binding {
    variable: string;
    entity: GraphNode;
    record: SimRecord;
    tenant?: string;
}

interface FixtureData {
    name?: string;
    entity: string;
    assignments?: { name: string, value: ExprData }[];
}

const RESERVED = new Set(['and', 'or', 'not', 'in', 'when', 'fn', 'do', 'end', 'catch', 'rescue', 'after', 'else', 'true', 'false', 'nil', 'actor', 'error', 'pid']);

function scenarioBody(scenario: GraphNode, context: MapContext): string[] {
    const call = scenarioCall(context.graph, scenario) ?? fail('its call does not resolve');
    const action = context.node(call.target)!;
    if (action.kind === 'UseCase') fail(`the use case ${lastOf(action.qn)} is not generated yet (its own registry task)`);
    const entity = action.data.entity ? context.node(action.data.entity as string) : undefined;
    if (!entity) fail(`${lastOf(action.qn)} is not generated yet, it has no entity (its own registry task)`);
    const result = simulator(context).scenario(scenario.qn);
    if (!result.passed) fail(`the simulator does not pass it: ${result.failures.join(' ')}`);

    const lines: string[] = [];
    const bindings = new Map<string, Binding>();
    const vars = new Map<string, Value>();
    const fixtures = (scenario.data.fixtures ?? []) as FixtureData[];
    fixtures.forEach((fixture, i) => {
        const node = context.node(fixture.entity)!;
        const home = homeAt(node, context);
        const label = fixture.name ?? `the ${lastOf(node.qn)} row`;
        const given = new Map((fixture.assignments ?? []).map(a => [a.name, a.value]));
        const fields = home?.resource ? homeFields(home, context) : fieldsOf(node, context);
        const { pairs, samples } = attributes(fields, given, label, i + 1, bindings, context);
        // The row as the simulator builds it (defaults, [] for lists, null for optional fields, then the given values), with the samples.
        const record: SimRecord = { $type: node.qn, $id: `${scenario.qn}#${i + 1}` };
        for (const field of fieldsOf(node, context)) {
            const type = field.data.type as TypeData;
            if (field.data.derived) continue;
            const name = lastOf(field.qn);
            if (field.data.default) record[name] = simulator(context).evaluate(field.data.default as ExprData, { self: record, vars });
            else if (type.many) record[name] = [];
            else if (type.optional) record[name] = null;
        }
        for (const [name, value] of given) record[name] = simulator(context).evaluate(value, { vars });
        for (const [name, value] of samples) record[name] = value;
        const partition = home?.resource ? undefined : partitionOf(node, context);
        let tenant: string | undefined;
        if (partition) {
            const owner = given.get(partition);
            tenant = owner && bindingOf(owner, bindings) ? `${bindingOf(owner, bindings)!.variable}.id` : fail(`${label} gives no ${partition}, the tenant of ${lastOf(node.qn)}`);
        }
        const seed = `Ash.Seed.seed!(${typeModule(node, context)}, %{${pairs.map(([n, v]) => `${n}: ${v}`).join(', ')}}${tenant ? `, tenant: ${tenant}` : ''})`;
        if (!fixture.name) {
            lines.push(seed);
            return;
        }
        const variable = variableFor(fixture.name, bindings);
        lines.push(`${variable} = ${seed}`);
        bindings.set(fixture.name, { variable, entity: node, record, tenant });
        vars.set(fixture.name, record);
    });

    const persona = scenario.data.actor as { persona: string, assignments?: { name: string, value: ExprData }[] } | undefined;
    let home: ActorHome | undefined;
    const actorVariable = [...bindings.values()].some(b => b.variable === 'actor') ? 'scenario_actor' : 'actor';
    if (persona) {
        const named = context.node(persona.persona)!;
        const actor = named.kind === 'Role'
            ? context.graph.nodes.find(n => n.kind === 'Actor' && ((n.data.roles ?? []) as string[]).includes(named.qn)) ?? fail(`no actor holds the role ${lastOf(named.qn)}`)
            : named;
        home = homeOf(actor, context);
        const roles = `[${((actor.data.roles ?? []) as string[]).map(r => `:${snake(lastOf(r))}`).join(', ')}]`;
        const given = new Map((persona.assignments ?? []).map(a => [a.name, a.value]));
        if (home.resource) {
            const { pairs } = attributes(homeFields(home, context), given, `the actor ${lastOf(actor.qn)}`, fixtures.length + 1, bindings, context);
            lines.push(`${actorVariable} = Ash.Seed.seed!(${home.module}, %{${[...pairs, ['roles', roles]].map(([n, v]) => `${n}: ${v}`).join(', ')}})`);
        } else {
            const keys = [...given].map(([name, value]) => {
                const field = fieldsOf(actor, context).find(f => lastOf(f.qn) === name) ?? fail(`the actor ${lastOf(actor.qn)} has no stored ${name}`);
                return attribute(field, value, bindings, context);
            });
            lines.push(`${actorVariable} = %${home.module}{${[...keys, ['roles', roles]].map(([n, v]) => `${n}: ${v}`).join(', ')}}`);
        }
    }

    const target = bindingOf(call.args[0], bindings);
    if (!target || target.entity.qn !== entity.qn) fail(`the first argument of ${lastOf(action.qn)} is not a given ${lastOf(entity.qn)} row`);
    const inputs = children(action, context, 'Param').flatMap((param, i): [string, string][] => {
        const arg = call.args[i + 1];
        if (!arg) return [];
        if (relationTarget(param, context)) fail(`the input ${lastOf(param.qn)} of ${lastOf(action.qn)} is a ${lastOf(relationTarget(param, context)!.qn)} row, which the generated argument does not take`);
        return [[lastOf(param.qn), elixirValue(arg, param.data.type as TypeData, context) ?? fail(`the input ${lastOf(param.qn)} does not translate`)]];
    });
    const options = [`action: :${snake(lastOf(action.qn))}`, persona ? `actor: ${actorVariable}` : 'authorize?: false', ...(target.tenant ? [`tenant: ${target.tenant}`] : [])];
    const run = `Ash.update(${target.variable}, %{${inputs.map(([n, v]) => `${n}: ${v}`).join(', ')}}, ${options.join(', ')})`;
    if (call.endpoint) {
        const endpoint = context.node(call.endpoint)!;
        lines.push(`# ${endpoint.data.verb} ${endpoint.data.path} of ${lastOf(parentOf(endpoint.qn))}, called through its action`);
    }

    const ash = new UpdateAction(action, entity, target.record, context);
    // Policies decide only for a call with an actor; then Ash's policies must say what the model's say.
    const authorizes = () => {
        if (!persona || !enforced(context)) return;
        const policies = [
            ...children(action, context, 'Policy'),
            ...children(entity, context, 'Policy').filter(p => !((p.data.fields ?? []) as string[]).length && covers(p, 'update'))
        ];
        for (const policy of policies) {
            if (!policyTranslates(policy, context)) fail(`the policy ${policy.qn} does not translate, so Ash forbids the call`);
            if (!checksAnswer(policy.data.condition as ExprData, home!, context)) fail(`a role check that ${policy.qn} names is a registry task for ${home!.module}`);
        }
    };
    if (scenario.data.refused) {
        if (ash.creates) fail(`${lastOf(action.qn)} creates rows, whose create policies the simulator checks and Ash does not`);
        ash.passes('Ash checks the policies only after the validations');
        lines.push(`assert {:error, %Ash.Error.Forbidden{}} = ${run}`);
    } else if (scenario.data.fails) {
        authorizes();
        const error = scenario.data.error as string | undefined;
        if (error) {
            const precondition = ash.preconditions.find(p => p.error === error)
                ?? fail(`the precondition that fails with ${lastOf(error)} does not translate to a validation (a registry task of ${lastOf(action.qn)})`);
            if (!ash.isFalse(precondition.condition)) fail(`the validation for ${lastOf(error)} is not proven to fail on the given rows`);
            lines.push(`assert {:error, error} = ${run}`, `assert Exception.message(error) =~ ${elixirString(lastOf(error))}`);
        } else {
            if (!ash.fails()) fail(`no validation or state check of the generated action fails like the model: ${result.reasons.join('; ')}`);
            lines.push(`assert {:error, _} = ${run}`);
        }
    } else {
        authorizes();
        ash.applies();
        ash.passes('a validation of the generated action may fail');
        lines.push(`assert {:ok, _} = ${run}`);
        const checks = (scenario.data.checks ?? []) as { $type: string, condition?: ExprData, event?: string }[];
        const translator = new CheckTranslator(bindings, context);
        const asserts = checks.map(check => {
            if (check.$type !== 'Expectation') fail(`the generated project does not publish ${lastOf(check.event!)} yet (a registry task of the event)`);
            return `assert ${bare(translator.bool(check.condition!) ?? fail(`the check ${(scenario.props.checks as string[])[checks.indexOf(check)]} does not translate`))}`;
        });
        for (const [name, loads] of translator.reads) {
            const variable = bindings.get(name)!.variable;
            lines.push(`${variable} = Ash.reload!(${variable}, ${loads.size ? `load: [${[...loads].map(l => `:${l}`).join(', ')}], ` : ''}authorize?: false)`);
        }
        lines.push(...asserts);
    }
    return unusedMarked(lines);
}

/** A policy without operations covers every operation. */
function covers(policy: GraphNode, operation: string): boolean {
    const operations = (policy.data.operations ?? []) as string[];
    return !operations.length || operations.includes(operation);
}

/**
 * The update action the generator writes for an action, as far as it decides the call: its translated
 * preconditions and guard (validations before the changes), the state check of AshStateMachine, its changes, and
 * the translated invariants of the entity, which Ash checks after the changes.
 */
class UpdateAction {
    readonly preconditions: { condition: ExprData, error?: string }[];
    private readonly transitions: GraphNode[];
    private readonly guard?: ExprData;
    private readonly effects: GraphNode[];
    private readonly state?: string;
    readonly creates: boolean;

    constructor(private readonly action: GraphNode, private readonly entity: GraphNode, private readonly before: SimRecord, private readonly context: MapContext) {
        const stored = storedAttributes(entity, context);
        const translates = (condition: ExprData) => validation(condition, stored, context.node) !== undefined;
        this.preconditions = ((action.data.preconditions ?? []) as { condition: ExprData, error?: string }[]).filter(p => translates(p.condition));
        this.transitions = context.graph.nodes.filter(n => n.kind === 'Transition' && n.data.action === action.qn);
        const guarded = this.transitions.filter(t => t.data.guard);
        // actionSteps writes the guard of a single transition as a validation, every other guard is a task.
        if (this.transitions.length === 1 && guarded.length === 1 && translates(guarded[0].data.guard as ExprData)) this.guard = guarded[0].data.guard as ExprData;
        if (new Set(this.transitions.map(t => t.data.to)).size > 1) fail(`${lastOf(action.qn)} has no single target state, which is a registry task`);
        this.effects = [...children(action, context), ...this.transitions.flatMap(t => children(t, context))].filter(c => c.kind.endsWith('Effect'));
        this.creates = this.effects.some(e => e.kind === 'CreateEffect');
        if (this.transitions.length) this.state = lastOf(context.node(parentOf(this.transitions[0].qn))!.data.field as string);
    }

    /** Whether the condition is false on the row before the call. */
    isFalse(condition: ExprData): boolean {
        return simulator(this.context).evaluate(condition, { self: this.before }) === false;
    }

    private isTrue(condition: ExprData, self: SimRecord = this.before): boolean {
        return simulator(this.context).evaluate(condition, { self }) === true;
    }

    /** Whether AshStateMachine lets the row leave its state with this action. */
    private leaves(): boolean {
        return !this.state || this.transitions.some(t => (t.data.from as string[]).includes(String(this.before[this.state!])));
    }

    /** Fails unless every validation and the state check of the action pass on the given rows. */
    passes(why: string): void {
        if (!this.preconditions.every(p => this.isTrue(p.condition))) fail(`${why}: a translated precondition of ${lastOf(this.action.qn)} is not proven true`);
        if (this.guard && !this.isTrue(this.guard)) fail(`${why}: the guard of ${lastOf(this.action.qn)} is not proven true`);
        if (!this.leaves()) fail(`${why}: AshStateMachine refuses the state ${String(this.before[this.state!])}`);
        const changed = new Set(this.effects.filter(e => e.kind === 'SetEffect').map(e => e.data.field as string));
        const after: SimRecord = this.state ? { ...this.before, [this.state]: this.transitions[0].data.to as string } : this.before;
        for (const invariant of enforcedInvariants(this.entity, this.context)) {
            if ([...targets(invariant.data.condition)].some(f => changed.has(f))) fail(`${why}: the invariant "${invariant.data.label}" reads a field ${lastOf(this.action.qn)} sets`);
            if (!this.isTrue(invariant.data.condition as ExprData, after)) fail(`${why}: the invariant "${invariant.data.label}" is not proven true after the call`);
        }
    }

    /** Whether a validation or the state check fails on the given rows. */
    fails(): boolean {
        return this.preconditions.some(p => this.isFalse(p.condition)) || (!!this.guard && this.isFalse(this.guard)) || !this.leaves();
    }

    /** Fails unless the generated action makes every change the model's action makes. */
    applies(): void {
        for (const effect of this.effects.filter(e => e.kind === 'SetEffect')) {
            if (!effectChange(effect, this.context)) fail(`the effect ${lastOf(effect.qn)} of ${lastOf(this.action.qn)} is a registry task`);
        }
    }
}

/** The `key: value` pairs of a row or an actor record: the given values, then samples for required attributes the scenario does not give. */
function attributes(fields: GraphNode[], given: Map<string, ExprData>, label: string, index: number, bindings: Map<string, Binding>, context: MapContext): { pairs: [string, string][], samples: Map<string, Value> } {
    const pairs: [string, string][] = [];
    const samples = new Map<string, Value>();
    const stored = fields.filter(f => !f.data.derived);
    for (const name of given.keys()) if (!stored.some(f => lastOf(f.qn) === name)) fail(`${label} gives ${name}, which is not stored`);
    for (const field of stored) {
        const name = lastOf(field.qn);
        const type = field.data.type as TypeData;
        const value = given.get(name);
        if (value) {
            pairs.push(attribute(field, value, bindings, context));
            continue;
        }
        const target = relationTarget(field, context);
        if (target) {
            if (!type.optional && !type.many) fail(`${label} gives no ${name}, a required ${lastOf(target.qn)}`);
            continue;
        }
        if (field.data.default) {
            if (!type.optional && defaultValue(field, context) === undefined) fail(`the default of ${name} does not translate`);
            continue;
        }
        if (type.many) {
            pairs.push([name, '[]']);
            continue;
        }
        if (type.optional) continue;
        const unique = ((field.data.modifiers ?? []) as string[]).includes('unique');
        const value_ = sampleOf(name, type, unique, index, context) ?? fail(`there is no sample for ${name} of ${label}`);
        pairs.push([name, value_.elixir]);
        samples.set(name, value_.value);
    }
    return { pairs, samples };
}

/** A given value as the attribute Ash stores: a relationship as the related row's id, everything else as an Elixir value. */
function attribute(field: GraphNode, value: ExprData, bindings: Map<string, Binding>, context: MapContext): [string, string] {
    const name = lastOf(field.qn);
    const type = field.data.type as TypeData;
    const target = relationTarget(field, context);
    if (target) {
        if (type.many) fail(`${name} lists ${lastOf(target.qn)} rows, a relationship the generated project does not model yet`);
        if (value.$type === 'NullExpr') return [`${name}_id`, 'nil'];
        const related = bindingOf(value, bindings) ?? fail(`${name} is not a given row`);
        return [`${name}_id`, `${related.variable}.id`];
    }
    return [name, elixirValue(value, type, context) ?? fail(`the value of ${name} does not translate`)];
}

/** A literal, an enum value, `now` or a list of them as an Elixir value of the type; undefined for anything else. */
function elixirValue(expr: ExprData, type: TypeData, context: MapContext): string | undefined {
    if (type.many) {
        if (expr.$type !== 'ListExpr') return undefined;
        const items = (expr.items ?? []).map(i => elixirValue(i, { ...type, many: false }, context));
        return items.every(i => i !== undefined) ? `[${items.join(', ')}]` : undefined;
    }
    const decl = type.decl ? context.node(type.decl) : undefined;
    switch (expr.$type) {
        case 'NullExpr': return 'nil';
        case 'StringExpr': return ['String', 'Text', 'Uuid'].includes(type.primitive ?? '') ? elixirString(String(expr.value)) : undefined;
        case 'BoolExpr': return type.primitive === 'Bool' ? String(String(expr.value) === 'true') : undefined;
        case 'NumberExpr': {
            const number = String(expr.value);
            if (type.primitive === 'Decimal' || type.primitive === 'Money') return `Decimal.new(${JSON.stringify(number)})`;
            return type.primitive === 'Int' && /^-?\d+$/.test(number) ? number : undefined;
        }
        case 'NameExpr': {
            if (expr.call) return undefined;
            if (decl?.kind === 'Enum' && expr.target && context.node(expr.target)?.kind === 'EnumLiteral') return `:${expr.name}`;
            if (expr.name === 'now' && !expr.target) return type.primitive === 'DateTime' ? 'DateTime.utc_now()' : type.primitive === 'Date' ? 'Date.utc_today()' : undefined;
            return undefined;
        }
        default: return undefined;
    }
}

/** A sample value of a required attribute: unique per row, and a map of samples for a value type. */
function sampleOf(name: string, type: TypeData, unique: boolean, index: number, context: MapContext): { elixir: string, value: Value } | undefined {
    const decl = type.decl ? context.node(type.decl) : undefined;
    if (decl?.kind === 'ValueType') {
        const pairs: string[] = [];
        for (const field of fieldsOf(decl, context).filter(f => !f.data.derived)) {
            const fieldType = field.data.type as TypeData;
            if (fieldType.optional) continue;
            const value = fieldType.many ? { elixir: '[]' } : sampleOf(lastOf(field.qn), fieldType, false, index, context);
            if (!value) return undefined;
            pairs.push(`${lastOf(field.qn)}: ${value.elixir}`);
        }
        return { elixir: `%{${pairs.join(', ')}}`, value: UNKNOWN };
    }
    if (type.primitive === 'String' || type.primitive === 'Text') return { elixir: JSON.stringify(`${name}-${index}`), value: UNKNOWN };
    if (type.primitive === 'Int' && unique) return { elixir: String(index), value: index };
    return sample(name, type, context);
}

function bindingOf(expr: ExprData | undefined, bindings: Map<string, Binding>): Binding | undefined {
    return expr?.$type === 'NameExpr' && !expr.target && !expr.call ? bindings.get(expr.name!) : undefined;
}

function variableFor(name: string, bindings: Map<string, Binding>): string {
    let variable = snake(name);
    if (RESERVED.has(variable)) variable = `${variable}_row`;
    while ([...bindings.values()].some(b => b.variable === variable)) variable = `${variable}_`;
    return variable;
}

/** Prefixes the variables the test assigns and never reads with `_`, so ExUnit does not warn. */
function unusedMarked(lines: string[]): string[] {
    return lines.map((line, i) => {
        const assigned = /^(\w+) = /.exec(line)?.[1];
        if (!assigned) return line;
        const rest = lines.slice(i + 1).join('\n');
        return new RegExp(`(^|[^\\w.:])${assigned}\\b`).test(rest) ? line : `_${line}`;
    });
}

/** An expression without its outer parentheses. */
function bare(code: string): string {
    if (!code.startsWith('(') || !code.endsWith(')')) return code;
    let depth = 0;
    for (let i = 0; i < code.length; i++) {
        if (code[i] === '(') depth++;
        else if (code[i] === ')') depth--;
        if (depth === 0 && i < code.length - 1) return code;
    }
    return code.slice(1, -1);
}

/** One side of a check: Elixir code and what it holds, for how it compares. */
interface Term {
    code: string;
    kind: 'record' | 'decimal' | 'number' | 'value' | 'time' | 'nil';
}

const DECIMAL_COMPARE: Record<string, string> = { '==': '== :eq', '!=': '!= :eq', '<': '== :lt', '>': '== :gt', '<=': 'in [:lt, :eq]', '>=': 'in [:gt, :eq]' };

/**
 * Translates a scenario check to an Elixir condition over the rows read back after the call: attributes of the
 * given rows, relationships as ids, calculations the generator writes (loaded on reload), literals and enum
 * values; decimals compare with `Decimal.compare`. Undefined for anything else.
 */
class CheckTranslator {
    /** The given rows the checks read, by binding name, with the calculations to load. */
    readonly reads = new Map<string, Set<string>>();

    constructor(private readonly bindings: Map<string, Binding>, private readonly context: MapContext) {}

    bool(expr: ExprData): string | undefined {
        switch (expr.$type) {
            case 'BoolExpr': return String(String(expr.value) === 'true');
            case 'UnaryExpr': {
                const operand = expr.op === '!' ? this.bool(expr.operand!) : undefined;
                return operand && `not ${wrap(operand)}`;
            }
            case 'NameExpr': {
                if (!expr.call || expr.name !== 'has' || !expr.args?.[0]) return undefined;
                const term = this.term(expr.args[0]);
                return term && term.kind !== 'nil' ? `not is_nil(${term.code})` : undefined;
            }
            case 'MemberExpr': {
                const term = this.term(expr);
                return term && expr.type === 'Bool' ? `${term.code} == true` : undefined;
            }
            case 'BinaryExpr': break;
            default: return undefined;
        }
        if (expr.op === '&&' || expr.op === '||') {
            const [left, right] = [this.bool(expr.left!), this.bool(expr.right!)];
            return left && right && `(${wrap(left)} ${expr.op === '&&' ? 'and' : 'or'} ${wrap(right)})`;
        }
        if (expr.op === 'in') {
            const left = this.term(expr.left!);
            const items = expr.right?.$type === 'ListExpr' ? (expr.right.items ?? []).map(i => this.term(i)) : undefined;
            if (!left || !items || items.some(i => !i) || left.kind !== 'value' || items.some(i => i!.kind !== 'value')) return undefined;
            return `(${left.code} in [${items.map(i => i!.code).join(', ')}])`;
        }
        const op = expr.op!;
        if (!(op in DECIMAL_COMPARE)) return undefined;
        const [left, right] = [this.term(expr.left!), this.term(expr.right!)];
        if (!left || !right) return undefined;
        if (left.kind === 'nil' || right.kind === 'nil') {
            const other = left.kind === 'nil' ? right : left;
            if (other.kind === 'nil') return undefined;
            return op === '==' ? `is_nil(${other.code})` : op === '!=' ? `not is_nil(${other.code})` : undefined;
        }
        if (left.kind === 'record' || right.kind === 'record') {
            return left.kind === right.kind && (op === '==' || op === '!=') ? `(${left.code} ${op} ${right.code})` : undefined;
        }
        if (left.kind === 'decimal' || right.kind === 'decimal') {
            const decimal = (t: Term) => t.kind === 'number' ? `Decimal.new(${JSON.stringify(t.code)})` : t.kind === 'decimal' ? t.code : undefined;
            const [a, b] = [decimal(left), decimal(right)];
            return a && b && `(Decimal.compare(${a}, ${b}) ${DECIMAL_COMPARE[op]})`;
        }
        if (left.kind === 'time' || right.kind === 'time') return undefined;
        const ordered = op !== '==' && op !== '!=';
        if (ordered && !(numeric(expr.left!) && numeric(expr.right!))) return undefined;
        return `(${left.code} ${op} ${right.code})`;
    }

    private term(expr: ExprData): Term | undefined {
        switch (expr.$type) {
            case 'NullExpr': return { code: 'nil', kind: 'nil' };
            case 'StringExpr': return { code: elixirString(String(expr.value)), kind: 'value' };
            case 'BoolExpr': return { code: String(String(expr.value) === 'true'), kind: 'value' };
            case 'NumberExpr': return { code: String(expr.value), kind: 'number' };
            case 'NameExpr': {
                if (expr.call) return undefined;
                const binding = !expr.target ? this.bindings.get(expr.name!) : undefined;
                // A given row as a whole compares by id, which the call does not change.
                if (binding) return { code: `${binding.variable}.id`, kind: 'record' };
                return expr.target && this.context.node(expr.target)?.kind === 'EnumLiteral' ? { code: `:${expr.name}`, kind: 'value' } : undefined;
            }
            case 'MemberExpr': {
                const receiver = expr.receiver;
                const binding = !expr.call && receiver?.$type === 'NameExpr' && !receiver.target && !receiver.call ? this.bindings.get(receiver.name!) : undefined;
                const field = binding && expr.target ? this.context.node(expr.target) : undefined;
                if (!binding || field?.kind !== 'Field') return undefined;
                const type = field.data.type as TypeData;
                if (type.many) return undefined;
                const loads = this.read(receiver!.name!);
                const access = `${binding.variable}.${expr.member}`;
                if (relationTarget(field, this.context)) return field.data.derived ? undefined : { code: `${access}_id`, kind: 'record' };
                if (field.data.derived) {
                    if (!calculation(field, this.context)) return undefined;
                    loads.add(expr.member!);
                }
                if (type.primitive === 'Decimal' || type.primitive === 'Money') return { code: access, kind: 'decimal' };
                if (['Date', 'DateTime', 'Duration'].includes(type.primitive ?? '')) return { code: access, kind: 'time' };
                return { code: access, kind: 'value' };
            }
            default: return undefined;
        }
    }

    private read(name: string): Set<string> {
        let loads = this.reads.get(name);
        if (!loads) this.reads.set(name, loads = new Set());
        return loads;
    }
}

function numeric(expr: ExprData): boolean {
    return expr.type.replace(/\?$/, '') === 'Int';
}

function wrap(code: string): string {
    return /^[\w.:]+$/.test(code) || (code.startsWith('(') && bare(code) !== code) ? code : `(${code})`;
}

import type { MapContext, Step } from '@appling/codegen';
import { scenarioCall, type ExprData, type GraphNode, type TypeData } from '@appling/model';
import { enforced, policyCondition } from './access.js';
import { useCaseCode } from './application.js';
import { actionSteps } from './behavior.js';
import { children } from './files.js';
import { factory, sample, simulator } from './fixtures.js';
import { actorFields, defaultValue, scope, userEntity, userModel } from './models.js';
import { appOf, lastOf, python, snake, type PythonScope } from './python.js';
import { testSteps } from './tests.js';

interface Assignment { name: string, value: ExprData }
interface Fixture { name?: string, entity: string, assignments?: Assignment[] }
interface Check { $type: string, condition?: ExprData, event?: string, assignments?: Assignment[] }
interface CallData { target: string, args?: ExprData[] }
interface UseCaseStep { $type: string, call?: CallData, handlers?: { error: string, call: CallData }[] }

const TEXT = ['String', 'Text'];
/** Names a binding must not take, as the test uses them itself: Python keywords, builtins and the test's own locals. */
const TAKEN = new Set([
    'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except',
    'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try',
    'while', 'with', 'yield', 'len', 'sum', 'min', 'max', 'any', 'all', 'str', 'Exception', 'self', 'actor', 'client', 'response', 'raised', 'fields'
]);

/** Why a scenario test cannot be generated; it then stays a skipped test with a registry task. */
class Gap extends Error {}

function gap(why: string): never {
    throw new Gap(why);
}

/**
 * A scenario becomes one test in `<app>/tests.py`: its given rows (with samples for the required fields it does
 * not give), its actor as a user in the actor's group, its call of the action or use case function and its `then`. What cannot be generated stays a skipped test and a task.
 */
export function scenarioSteps(scenario: GraphNode, context: MapContext): Step[] {
    const rule = ruleOf(scenario);
    const name = snake(lastOf(scenario.qn));
    const imports = new Set<string>();
    const steps: Step[] = [];
    try {
        const test = new ScenarioTest(scenario, context, imports, steps);
        const body = test.body();
        const clash = [...test.bindings].find(b => importedNames(imports).has(b) || /^row_\d+$|_sent$|^record_/.test(b));
        if (clash) gap(`the binding ${clash} clashes with a name the test imports or uses`);
        return testSteps(scenario, rule, [{ name, body }], context, imports, steps);
    } catch (error) {
        if (!(error instanceof Gap)) throw error;
        return testSteps(scenario, rule, [{ name, why: error.message }], context);
    }
}

function ruleOf(scenario: GraphNode): string {
    const props = scenario.props;
    const error = scenario.data.error as string | undefined;
    const then = props.refused ? 'refused' : props.fails ? `fails${error ? ` ${lastOf(error)}` : ''}` : ((props.checks ?? []) as string[]).join('; ');
    return `when ${String(props.call)}${then ? ` then ${then}` : ''}`;
}

class ScenarioTest {
    readonly bindings = new Set<string>();
    private readonly data: { [key: string]: unknown };

    constructor(private readonly scenario: GraphNode, private readonly context: MapContext, private readonly imports: Set<string>, private readonly steps: Step[]) {
        this.data = scenario.data;
    }

    body(): string[] {
        const { scenario, context, data } = this;
        let passed = false;
        try {
            passed = simulator(context).scenario(scenario.qn).passed;
        } catch {
            passed = false;
        }
        if (!passed) gap('the scenario does not pass in appling check');
        const call = scenarioCall(scenario);
        const target = context.node(call.target)!;
        if (target.kind !== 'Action' && target.kind !== 'UseCase') gap(`${lastOf(target.qn)} is neither an action nor a use case`);
        const missing = gaps(target, context, new Set());
        if (missing) gap(missing);

        const lines: string[] = [];
        const fixtures = (data.fixtures ?? []) as Fixture[];
        fixtures.forEach((fixture, i) => {
            if (fixture.name && TAKEN.has(fixture.name)) gap(`the binding ${fixture.name} is a name the test uses itself`);
            lines.push(...this.row(this.context.node(fixture.entity)!, fixture.assignments ?? [], fixture.name, fixture.name ?? `row-${i + 1}`, i + 1));
            if (fixture.name) this.bindings.add(fixture.name);
        });
        const persona = data.actor as { persona: string, assignments?: Assignment[] } | undefined;
        if (persona) lines.push(...this.actor(persona, fixtures.length + 1));

        const callScope: PythonScope = { ...scope(context, this.imports), vars: this.bindings, actor: persona ? 'actor' : undefined };
        const params = children(target, context, 'Param');
        const entityFirst = target.kind === 'Action' && Boolean(target.data.entity);
        const args = call.args.map((arg, i) => {
            const param = params[i - (entityFirst ? 1 : 0)];
            return this.value(arg, entityFirst && i === 0 ? undefined : param?.data.type as TypeData, callScope) ?? gap(`an argument of the call is not translated to Python`);
        });
        const direct = () => this.direct(target, args, Boolean(persona));
        const error = data.error as string | undefined;

        if (data.refused) {
            this.imports.add('from django.core.exceptions import PermissionDenied');
            return [...lines, 'with self.assertRaises(PermissionDenied):', `    ${direct()}`];
        }
        if (data.fails) {
            if (error) {
                const declared = lastOf(error);
                this.imports.add(`from ${appOf(context.node(error)!.module)}.errors import ${declared}`);
                return [...lines, `with self.assertRaises(${declared}):`, `    ${direct()}`];
            }
            const refusable = persona && enforced(context);
            if (refusable) this.imports.add('from django.core.exceptions import PermissionDenied');
            return [...lines, `with self.assertRaises(Exception)${refusable ? ' as raised' : ''}:`, `    ${direct()}`, ...(refusable ? ['self.assertNotIsInstance(raised.exception, PermissionDenied)'] : [])];
        }
        return [...lines, ...this.then([direct()], callScope)];
    }

    /** Creates a row: the values given, samples for required fields without a default, related rows from their factories. */
    private row(entity: GraphNode, assignments: Assignment[], variable: string | undefined, label: string, number: number): string[] {
        const { context, imports } = this;
        const model = lastOf(entity.qn);
        imports.add(`from ${appOf(entity.module)}.models import ${model}`);
        const given = new Map(assignments.map(a => [a.name, a.value]));
        const pyScope: PythonScope = { ...scope(context, imports), vars: this.bindings };
        const values: string[] = [];
        const lists: [string, string][] = [];
        for (const field of children(entity, context, 'Field')) {
            if (field.data.derived) continue;
            const type = field.data.type as TypeData;
            const name = lastOf(field.qn);
            const decl = type.decl ? context.node(type.decl) : undefined;
            const value = given.get(name);
            given.delete(name);
            if (value) {
                const code = this.value(value, type, pyScope) ?? gap(`the value of ${model}.${name} is not translated to Python`);
                if (type.many && decl?.kind === 'Entity') lists.push([name, code]);
                else values.push(`${name}=${code}`);
                continue;
            }
            // Lists, value types and optional fields have a model default ([], {}, None).
            if (type.many || type.optional || decl?.kind === 'ValueType') continue;
            if (field.data.default) {
                if (defaultValue(field, context, new Set()) === undefined) gap(`the default of ${model}.${name} is not generated`);
                continue;
            }
            if (decl?.kind === 'Entity') {
                const made = factory(decl, context) ?? gap(`no factory creates the ${lastOf(decl.qn)} of ${model}.${name}`);
                this.steps.push(...made.steps);
                imports.add(made.import);
                values.push(`${name}=${made.name}()`);
                continue;
            }
            const unique = ((field.data.modifiers ?? []) as string[]).includes('unique');
            values.push(`${name}=${this.sample(name, type, unique, number) ?? gap(`there is no sample value for ${model}.${name}`)}`);
        }
        // What is left are actor fields, stored on the user model.
        const stored = actorFields(context);
        for (const [name, value] of given) {
            const type = stored.find(f => lastOf(f.qn) === name)?.data.type as TypeData | undefined;
            values.push(`${name}=${this.value(value, type, pyScope) ?? gap(`the value of ${name} is not translated to Python`)}`);
        }
        if (userEntity(context) === entity.qn && !values.some(v => v.startsWith('username='))) values.unshift(`username=${JSON.stringify(label)}`);
        const name = variable ?? (lists.length ? `row_${number}` : undefined);
        return [
            `${name ? `${name} = ` : ''}${model}.objects.create(${values.join(', ')})`,
            ...lists.map(([field, code]) => `${name}.${field}.set(${code})`)
        ];
    }

    /** The user the call runs as, in the group of the declared actor (for a role, the first actor holding it). */
    private actor(persona: { persona: string, assignments?: Assignment[] }, number: number): string[] {
        const { context, imports } = this;
        const named = context.node(persona.persona)!;
        const actor = named.kind === 'Role' ? context.graph.nodes.find(n => n.kind === 'Actor' && ((n.data.roles ?? []) as string[]).includes(named.qn)) ?? named : named;
        const assignments = persona.assignments ?? [];
        const user = userModel(context);
        const lines: string[] = [];
        if (user?.entity) {
            lines.push(...this.row(user.entity, assignments, 'actor', 'actor', number));
        } else {
            if (!user && (assignments.length || context.graph.nodes.some(n => n.kind === 'Actor' && n.data.entity))) gap('the actor fields are not stored on a user model');
            const pyScope: PythonScope = { ...scope(context, imports), vars: this.bindings };
            const stored = actorFields(context);
            const values = assignments.map(a => {
                const type = stored.find(f => lastOf(f.qn) === a.name)?.data.type as TypeData | undefined;
                return `${a.name}=${this.value(a.value, type, pyScope) ?? gap(`the value of ${a.name} is not translated to Python`)}`;
            });
            imports.add('from django.contrib.auth import get_user_model');
            lines.push(`actor = get_user_model().objects.create(${['username="actor"', ...values].join(', ')})`);
        }
        imports.add('from django.contrib.auth.models import Group');
        lines.push(`actor.groups.add(Group.objects.get_or_create(name=${JSON.stringify(lastOf(actor.qn))})[0])`);
        return lines;
    }

    /** The call of the action or use case function; a use case gets a mock for each external system it calls. */
    private direct(target: GraphNode, args: string[], asActor: boolean): string {
        const { context, imports } = this;
        const fn = snake(lastOf(target.qn));
        const actor = asActor ? ['actor=actor'] : [];
        if (target.kind === 'Action') {
            imports.add(`from ${appOf(target.module)}.actions import ${fn}`);
            const inputs = children(target, context, 'Param').map(p => lastOf(p.qn));
            const positional = target.data.entity ? args.slice(0, 1) : [];
            const named = args.slice(positional.length).map((a, i) => `${inputs[i]}=${a}`);
            return `${fn}(${[...positional, ...named, ...actor].join(', ')})`;
        }
        imports.add(`from ${appOf(target.module)}.usecases import ${fn}`);
        const externals = useCaseCode(target, context).externals.map(e => {
            imports.add('from unittest.mock import Mock');
            imports.add(`from ${appOf(e.module)}.externals import ${lastOf(e.qn)}`);
            return `${snake(lastOf(e.qn))}=Mock(spec=${lastOf(e.qn)})`;
        });
        return `${fn}(${[...args, ...actor, ...externals].join(', ')})`;
    }

    /** The call that is expected to run, then the checks: the given rows reloaded, each expectation, each emitted event. */
    private then(call: string[], callScope: PythonScope): string[] {
        const { context, imports } = this;
        const checks = (this.data.checks ?? []) as Check[];
        const setup: string[] = [];
        const sent = new Map<string, string>();
        for (const check of checks.filter(c => c.$type === 'Emitted')) {
            if (sent.has(check.event!)) continue;
            const event = context.node(check.event!)!;
            const signal = snake(lastOf(event.qn));
            imports.add(`from ${appOf(event.module)}.events import ${signal}`);
            sent.set(event.qn, `${signal}_sent`);
            setup.push(
                `${signal}_sent = []`,
                '',
                `def record_${signal}(sender, **fields):`,
                `    ${signal}_sent.append(fields)`,
                '',
                `${signal}.connect(record_${signal}, weak=False)`,
                `self.addCleanup(${signal}.disconnect, record_${signal})`
            );
        }
        const run = sent.size ? ['with self.captureOnCommitCallbacks(execute=True):', ...call.map(l => `    ${l}`)] : call;
        const read = new Set<string>();
        const shown = (this.scenario.props.checks ?? []) as string[];
        const assertions = checks.map((check, i) => {
            if (check.$type === 'Expectation') {
                bindingsIn(check.condition!, this.bindings, read);
                return expectation(check.condition!, callScope) ?? gap(`the check ${shown[i]} is not translated to Python`);
            }
            const expected = (check.assignments ?? []).map(a => {
                bindingsIn(a.value, this.bindings, read);
                const value = python(a.value, callScope) ?? gap(`the value of ${a.name} in emitted ${lastOf(check.event!)} is not translated to Python`);
                return `fields.get(${JSON.stringify(a.name)}) == ${value}`;
            });
            const list = sent.get(check.event!)!;
            const message = JSON.stringify(`${lastOf(check.event!)} was not emitted${expected.length ? ` with ${(check.assignments ?? []).map(a => a.name).join(', ')} as given` : ''}`);
            return expected.length
                ? `self.assertTrue(any(${expected.join(' and ')} for fields in ${list}), ${message})`
                : `self.assertTrue(${list}, ${message})`;
        });
        return [
            ...setup,
            ...(setup.length ? [''] : []),
            ...run,
            ...[...read].map(b => `${b}.refresh_from_db()`),
            ...assertions
        ];
    }

    /** A value for a field or input of the given type; numbers become `Decimal` for decimal and money fields. */
    private value(expr: ExprData, type: TypeData | undefined, pyScope: PythonScope): string | undefined {
        if (expr.$type === 'NumberExpr' && !type?.many && (type?.primitive === 'Decimal' || type?.primitive === 'Money')) {
            this.imports.add('from decimal import Decimal');
            return `Decimal(${JSON.stringify(String(expr.value))})`;
        }
        return python(expr, pyScope);
    }

    /** A sample for a required field the scenario does not give, unique within the test where the field is unique. */
    private sample(name: string, type: TypeData, unique: boolean, number: number): string | undefined {
        if (!type.decl && TEXT.includes(type.primitive ?? '')) return JSON.stringify(`${name}-${number}`);
        if (unique && type.primitive === 'Int') return String(number);
        if (unique && (type.primitive === 'Decimal' || type.primitive === 'Money')) {
            this.imports.add('from decimal import Decimal');
            return `Decimal("${number}")`;
        }
        return sample(name, type, unique, this.context, this.imports)?.python;
    }
}

/** The names a set of import lines binds. */
function importedNames(imports: Set<string>): Set<string> {
    return new Set([...imports].flatMap(line => {
        const from = /^from \S+ import (.+)$/.exec(line);
        return from ? from[1].split(',').map(n => n.trim()) : [line.split(' ')[1].split('.')[0]];
    }));
}

/** An assertion for an expectation: `assertEqual` and `assertNotEqual` for comparisons, else `assertTrue`. */
function expectation(condition: ExprData, pyScope: PythonScope): string | undefined {
    if (condition.$type === 'BinaryExpr' && (condition.op === '==' || condition.op === '!=') && condition.right?.$type !== 'NullExpr') {
        const [left, right] = [python(condition.left!, pyScope), python(condition.right!, pyScope)];
        return left && right && `self.${condition.op === '==' ? 'assertEqual' : 'assertNotEqual'}(${left}, ${right})`;
    }
    const code = python(condition, pyScope);
    return code && `self.assertTrue(${code})`;
}

/** Collects the bindings an expression reads, which the test reloads after the call. */
function bindingsIn(expr: ExprData | undefined, bindings: Set<string>, found: Set<string>): void {
    if (!expr) return;
    if (expr.$type === 'NameExpr' && !expr.call && !expr.target && bindings.has(expr.name!)) found.add(expr.name!);
    for (const part of [expr.left, expr.right, expr.operand, expr.receiver, expr.index, ...(expr.args ?? []), ...(expr.items ?? [])]) bindingsIn(part, bindings, found);
}

/**
 * Why the code a scenario calls is not complete enough for a test that must pass: a task of the action or use case
 * (other than eventual consistency and its guessed tests), a policy without a Python condition, or a called
 * action that is incomplete. Undefined when it is complete.
 */
function gaps(target: GraphNode, context: MapContext, seen: Set<string>): string | undefined {
    if (seen.has(target.qn)) return undefined;
    seen.add(target.qn);
    const untranslated = (node: GraphNode | undefined) => node ? children(node, context, 'Policy').find(p => !policyCondition(p, context, new Set())) : undefined;
    if (target.kind === 'Action') {
        const pending = actionSteps(target, context).find(s => s.kind === 'task' && !s.what.startsWith('run the effects of') && !s.what.startsWith('write the test bodies'));
        if (pending?.kind === 'task') return `${lastOf(target.qn)} is not fully generated: ${pending.what}`;
        if (!enforced(context)) return undefined;
        const transitions = context.graph.nodes.filter(n => n.kind === 'Transition' && n.data.action === target.qn);
        const created = [target, ...transitions].flatMap(n => context.children(n.qn).filter(c => c.kind === 'CreateEffect').map(c => context.node(c.data.entity as string)));
        const entity = target.data.entity ? context.node(target.data.entity as string) : undefined;
        for (const node of [target, entity, ...created]) {
            const policy = untranslated(node);
            if (policy) return `the policy ${policy.qn} is not translated to Python`;
        }
        return undefined;
    }
    if (target.kind !== 'UseCase') return undefined;
    const pending = useCaseCode(target, context).tasks.find(s => s.kind === 'task' && !s.what.startsWith('continue '));
    if (pending?.kind === 'task') return `${lastOf(target.qn)} is not fully generated: ${pending.what}`;
    const policy = enforced(context) ? untranslated(target) : undefined;
    if (policy) return `the policy ${policy.qn} is not translated to Python`;
    for (const step of (target.data.steps ?? []) as UseCaseStep[]) {
        if (step.$type === 'AwaitStep') break;
        for (const call of [step.call, ...(step.handlers ?? []).map(h => h.call)]) {
            const node = call && context.node(call.target);
            const why = node && gaps(node, context, seen);
            if (why) return why;
        }
    }
    return undefined;
}

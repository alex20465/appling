import type { MapContext, Step } from '@appling/codegen';
import type { ExprData, GraphNode, Record as SimRecord } from '@appling/model';
import { canName, policyCondition, policyImport } from './access.js';
import { queryCode, useCaseExternals } from './application.js';
import { afterEffects, call, preconditionsHold, setup, valid } from './behavior-tests.js';
import { children } from './files.js';
import { factory, holds, simulator, type Factory } from './fixtures.js';
import { userModel } from './models.js';
import { appOf, lastOf, parentOf, snake } from './python.js';
import { testSteps, type TestCase } from './tests.js';

const OPERATIONS = ['read', 'create', 'update', 'delete'];
const CASES = ['allows_permitted_actors', 'denies_other_actors'];
const GROUP = 'from django.contrib.auth.models import Group';

/**
 * The tests of a policy whose condition reads the actor only through `actor.is(...)`: a user in the group of an
 * actor that the simulator proves gets through every check of the guarded element, and one it proves this policy
 * keeps out. A policy on a whole entity is checked against `can_<operation>_<entity>` on the factory row, one on an
 * action by calling the action, one on a query by looking for the factory row in its result, one on a use case by
 * expecting `PermissionDenied` before its first step (its allowed case stays a task). A case stays a
 * registry task when a condition on the way reads more of the actor than `actor.is(...)`, a role it names has a
 * condition, a fixture is missing, or no declared actor gets a certain verdict.
 */
export function policyTests(policy: GraphNode, context: MapContext): Step[] {
    const owner = context.node(parentOf(policy.qn));
    if (owner?.kind === 'Action') return actionPolicyTests(policy, owner, context);
    if (owner?.kind === 'Query') return queryPolicyTests(policy, owner, context);
    if (owner?.kind === 'UseCase') return useCasePolicyTests(policy, owner, context);
    const rule = String(policy.props.condition);
    const fallback = () => testSteps(policy, rule, CASES, context);
    if (owner?.kind !== 'Entity' || ((policy.data.fields ?? []) as string[]).length) return fallback();
    const entity = owner;
    const all = wholes(entity, context);
    const operations = covered(policy);
    if (![policy, ...all].every(p => checkable(p, context))) return fallback();
    const made = factory(entity, context);
    const user = userFactory(context);
    if (!made || !user) return fallback();
    const actors = actorsOf(context);
    const allowed = actors.map(actor => ({ actor, operations: operations.filter(o => all.filter(p => covered(p).includes(o)).every(p => verdict(p, actor, made.record, context) === true)) }))
        .find(a => verdict(policy, a.actor, made.record, context) === true && a.operations.length);
    const denied = actors.find(actor => verdict(policy, actor, made.record, context) === false);
    const imports = new Set([made.import, ...user.imports, GROUP]);
    const record = snake(lastOf(entity.qn));
    const body = (actor: GraphNode, assertion: 'assertTrue' | 'assertFalse', checked: string[]) => [
        ...signIn(user, actor),
        `${record} = ${made.name}()`,
        ...checked.map(o => `self.${assertion}(${policyImport(entity, canName(entity, o as 'read'), imports)}(${user.variable}, ${record}))`)
    ];
    const tests: TestCase[] = [
        { name: CASES[0], body: allowed && body(allowed.actor, 'assertTrue', allowed.operations) },
        { name: CASES[1], body: denied && body(denied, 'assertFalse', operations) }
    ];
    return testSteps(policy, rule, tests, context, imports, [...made.steps, ...user.steps]);
}

/**
 * The tests of an action's policy. The action first checks `can_update_<entity>` and every policy of its own, so
 * the allowed actor must pass all of them on the factory row; the call then has to run through, which the test
 * only claims when the simulator proves the preconditions and the invariants after the `set` effects hold and the
 * action neither moves a state, creates rows nor emits events. The denied actor gets `PermissionDenied`.
 */
function actionPolicyTests(policy: GraphNode, action: GraphNode, context: MapContext): Step[] {
    const rule = String(policy.props.condition);
    const fallback = () => testSteps(policy, rule, CASES, context);
    const entity = action.data.entity ? context.node(action.data.entity as string) : undefined;
    const updates = entity ? wholes(entity, context).filter(p => covered(p).includes('update')) : [];
    const guards = [...children(action, context, 'Policy'), ...updates];
    if (!guards.every(p => checkable(p, context))) return fallback();
    const run = setup(action, context);
    const user = userFactory(context);
    if (!run || !user || !valid(run.entity, run.record, context)) return fallback();
    const record = run.record ?? {};
    const effects = children(action, context).filter(c => c.kind.endsWith('Effect'));
    const transitions = context.graph.nodes.some(n => n.kind === 'Transition' && n.data.action === action.qn);
    const after = effects.every(e => e.kind === 'SetEffect') && !transitions ? afterEffects(effects, record, run.inputs, context) : undefined;
    const runs = after !== undefined && valid(run.entity, after, context) && preconditionsHold(action, run.record, run.inputs, context) && (!entity || updates.length > 0);
    const actors = actorsOf(context);
    const allowed = runs ? actors.find(actor => guards.every(p => verdict(p, actor, record, context) === true)) : undefined;
    const denied = actors.find(actor => verdict(policy, actor, record, context) === false);
    const imports = new Set([...run.imports, ...user.imports, GROUP]);
    if (denied) imports.add('from django.core.exceptions import PermissionDenied');
    const fire = call(action, run, [`actor=${user.variable}`]);
    const body = (actor: GraphNode, lines: string[]) => [...signIn(user, actor), ...(run.instance ? [`${run.instance} = make_${run.instance}()`] : []), ...lines];
    const tests: TestCase[] = [
        { name: CASES[0], body: allowed && body(allowed, [fire]) },
        { name: CASES[1], body: denied && body(denied, ['with self.assertRaises(PermissionDenied):', `    ${fire}`]) }
    ];
    if (tests.every(t => !t.body)) return fallback();
    return testSteps(policy, rule, tests, context, imports, [...run.steps, ...user.steps]);
}

/**
 * The tests of a query's policy: the factory row must be in the result for an actor that the entity's read
 * policies and every policy of the query let through (and the query's filter must hold for the row), and must not
 * be in it for an actor this policy keeps out.
 */
function queryPolicyTests(policy: GraphNode, query: GraphNode, context: MapContext): Step[] {
    const rule = String(policy.props.condition);
    const fallback = () => testSteps(policy, rule, CASES, context);
    const entity = context.node(query.data.entity as string);
    if (entity?.kind !== 'Entity' || !queryCode(query, context, new Set())) return fallback();
    const reads = wholes(entity, context).filter(p => covered(p).includes('read'));
    const guards = [...children(query, context, 'Policy'), ...reads];
    if (!guards.every(p => checkable(p, context))) return fallback();
    const made = factory(entity, context);
    const user = userFactory(context);
    if (!made || !user) return fallback();
    const selected = !query.data.filter || holds(query.data.filter as ExprData, context, made.record);
    const actors = actorsOf(context);
    const allowed = selected && reads.length ? actors.find(actor => guards.every(p => verdict(p, actor, made.record, context) === true)) : undefined;
    const denied = actors.find(actor => verdict(policy, actor, made.record, context) === false);
    const name = snake(lastOf(query.qn));
    const imports = new Set([made.import, ...user.imports, GROUP, `from ${appOf(query.module)}.queries import ${name}`]);
    const record = snake(lastOf(entity.qn));
    const body = (actor: GraphNode, assertion: 'assertIn' | 'assertNotIn') => [
        ...signIn(user, actor),
        `${record} = ${made.name}()`,
        `self.${assertion}(${record}, list(${name}(actor=${user.variable})))`
    ];
    const tests: TestCase[] = [
        { name: CASES[0], body: allowed && body(allowed, 'assertIn') },
        { name: CASES[1], body: denied && body(denied, 'assertNotIn') }
    ];
    if (tests.every(t => !t.body)) return fallback();
    return testSteps(policy, rule, tests, context, imports, [...made.steps, ...user.steps]);
}

/**
 * The tests of a use case's policy. The use case checks its own policies before its first step, so an actor this
 * policy keeps out gets `PermissionDenied` without any step running; the externals it takes are passed as `None`.
 * The allowed case runs the steps and stays a registry task.
 */
function useCasePolicyTests(policy: GraphNode, useCase: GraphNode, context: MapContext): Step[] {
    const rule = String(policy.props.condition);
    const fallback = () => testSteps(policy, rule, CASES, context);
    if (!checkable(policy, context)) return fallback();
    const run = setup(useCase, context);
    const user = userFactory(context);
    if (!run || !user) return fallback();
    const denied = actorsOf(context).find(actor => verdict(policy, actor, {}, context) === false);
    if (!denied) return fallback();
    const imports = new Set([...run.imports, ...user.imports, GROUP, 'from django.core.exceptions import PermissionDenied']);
    const externals = useCaseExternals(useCase, context).map(e => `${snake(lastOf(e.qn))}=None`);
    const fire = call(useCase, run, [`actor=${user.variable}`, ...externals]);
    const tests: TestCase[] = [
        { name: CASES[0] },
        { name: CASES[1], body: [...signIn(user, denied), 'with self.assertRaises(PermissionDenied):', `    ${fire}`] }
    ];
    return testSteps(policy, rule, tests, context, imports, [...run.steps, ...user.steps]);
}

/** The policies of an entity that cover whole rows (no `fields`). */
function wholes(entity: GraphNode, context: MapContext): GraphNode[] {
    return children(entity, context, 'Policy').filter(p => !((p.data.fields ?? []) as string[]).length);
}

/** Whether a test can rely on the simulated verdict of a policy for a user that is only in an actor's group. */
function checkable(policy: GraphNode, context: MapContext): boolean {
    return onlyActorKinds(policy.data.condition as ExprData, context) && policyCondition(policy, context, new Set()) !== undefined;
}

function actorsOf(context: MapContext): GraphNode[] {
    return context.graph.nodes.filter(n => n.kind === 'Actor');
}

function verdict(policy: GraphNode, actor: GraphNode, record: SimRecord, context: MapContext) {
    return simulator(context).evaluate(policy.data.condition as ExprData, { self: record, actor: { actor: actor.qn, fields: {} } });
}

function signIn(user: UserFactory, actor: GraphNode): string[] {
    return [
        `${user.variable} = ${user.create}`,
        `${user.variable}.groups.add(Group.objects.get_or_create(name=${JSON.stringify(lastOf(actor.qn))})[0])`
    ];
}

function covered(policy: GraphNode): string[] {
    const operations = (policy.data.operations ?? []) as string[];
    return operations.length ? operations : OPERATIONS;
}

interface UserFactory {
    create: string;
    variable: string;
    imports: string[];
    steps: Step[];
}

/** How a test creates a signed in user: the bound entity's factory, else the user model with a unique username. */
function userFactory(context: MapContext): UserFactory | undefined {
    const model = userModel(context);
    if (model?.entity) {
        const made: Factory | undefined = factory(model.entity, context);
        return made && { create: `${made.name}()`, variable: 'user', imports: [made.import], steps: made.steps };
    }
    return { create: 'get_user_model().objects.create(username="tester")', variable: 'user', imports: ['from django.contrib.auth import get_user_model'], steps: [] };
}

/**
 * Whether the condition reads the actor only through `actor.is(X)` with an X whose verdict needs no actor field
 * (an actor, or a role without a condition), so a user that is only in a group has the simulated verdict.
 */
function onlyActorKinds(expr: ExprData | undefined, context: MapContext): boolean {
    if (!expr) return true;
    if (expr.$type === 'MemberExpr' && expr.member === 'is' && expr.call && expr.receiver?.$type === 'NameExpr' && expr.receiver.name === 'actor' && !expr.receiver.target) {
        const target = expr.args?.[0]?.target;
        const node = target ? context.node(target) : undefined;
        return node?.kind === 'Actor' || node?.kind === 'Role' && !node.data.condition;
    }
    if (expr.$type === 'NameExpr' && expr.name === 'actor' && !expr.target) return false;
    const parts = [expr.left, expr.right, expr.operand, expr.receiver, expr.index, ...(expr.args ?? []), ...(expr.items ?? [])];
    return parts.every(p => onlyActorKinds(p, context));
}

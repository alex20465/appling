import type { MapContext, Step } from '@appling/codegen';
import type { ExprData, GraphNode } from '@appling/model';
import { canName, policyCondition, policyImport } from './access.js';
import { children } from './files.js';
import { factory, simulator, type Factory } from './fixtures.js';
import { userModel } from './models.js';
import { lastOf, parentOf, snake } from './python.js';
import { testSteps, type TestCase } from './tests.js';

const OPERATIONS = ['read', 'create', 'update', 'delete'];

/**
 * The tests of a policy on a whole entity: a user in the group of an actor that the simulator proves the policy
 * lets through (with every other policy of the operation), and one it proves the policy keeps out, each checked
 * against `can_<operation>_<entity>` on the entity's factory row. A case stays a registry task when the condition
 * reads more of the actor than `actor.is(...)`, a role it names has a condition, there is no factory, or no
 * declared actor gets a certain verdict.
 */
export function policyTests(policy: GraphNode, context: MapContext): Step[] {
    const cases = ['allows_permitted_actors', 'denies_other_actors'];
    const rule = String(policy.props.condition);
    const entity = context.node(parentOf(policy.qn));
    const fallback = () => testSteps(policy, rule, cases, context);
    if (entity?.kind !== 'Entity' || ((policy.data.fields ?? []) as string[]).length) return fallback();
    const wholes = children(entity, context, 'Policy').filter(p => !((p.data.fields ?? []) as string[]).length);
    const operations = covered(policy);
    if (![policy, ...wholes].every(p => onlyActorKinds(p.data.condition as ExprData, context) && policyCondition(p, context, new Set()))) return fallback();
    const made = factory(entity, context);
    const user = made && userFactory(context);
    if (!made || !user) return fallback();
    const actors = context.graph.nodes.filter(n => n.kind === 'Actor');
    const verdict = (p: GraphNode, actor: GraphNode) => simulator(context).evaluate(p.data.condition as ExprData, { self: made.record, actor: { actor: actor.qn, fields: {} } });
    const allowed = actors.map(actor => ({ actor, operations: operations.filter(o => wholes.filter(p => covered(p).includes(o)).every(p => verdict(p, actor) === true)) }))
        .find(a => verdict(policy, a.actor) === true && a.operations.length);
    const denied = actors.find(actor => verdict(policy, actor) === false);
    const imports = new Set([made.import, ...user.imports, 'from django.contrib.auth.models import Group']);
    const record = snake(lastOf(entity.qn));
    const body = (actor: GraphNode, assertion: 'assertTrue' | 'assertFalse', checked: string[]) => [
        `${user.variable} = ${user.create}`,
        `${user.variable}.groups.add(Group.objects.get_or_create(name=${JSON.stringify(lastOf(actor.qn))})[0])`,
        `${record} = ${made.name}()`,
        ...checked.map(o => `self.${assertion}(${policyImport(entity, canName(entity, o as 'read'), imports)}(${user.variable}, ${record}))`)
    ];
    const tests: TestCase[] = [
        { name: cases[0], body: allowed && body(allowed.actor, 'assertTrue', allowed.operations) },
        { name: cases[1], body: denied && body(denied, 'assertFalse', operations) }
    ];
    return testSteps(policy, rule, tests, context, imports, [...made.steps, ...user.steps]);
}

function covered(policy: GraphNode): string[] {
    const operations = (policy.data.operations ?? []) as string[];
    return operations.length ? operations : OPERATIONS;
}

/** How a test creates a signed in user: the bound entity's factory, else the user model with a unique username. */
function userFactory(context: MapContext): { create: string, variable: string, imports: string[], steps: Step[] } | undefined {
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

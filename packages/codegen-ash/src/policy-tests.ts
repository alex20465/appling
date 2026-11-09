import type { MapContext, Step } from '@appling/codegen';
import type { ExprData, GraphNode } from '@appling/model';
import { homeOf, rolesOf } from './actors.js';
import { lastOf, parentOf } from './elixir.js';
import { simulator } from './model-tests.js';
import { fieldsOf, relationTarget, snake, typeModule } from './naming.js';
import { checkLines, isTarget, split } from './roles.js';
import { testSteps, type TestCase } from './tests.js';

/** The default action of each operation, as `ash.gen.resource --default-actions` names it. */
const ACTIONS: Record<string, string> = { read: 'read', create: 'create', update: 'update', delete: 'destroy' };

/**
 * The tests of a policy on a whole entity. `Ash.can?` asks the resource's authorizer for its default action with
 * an actor struct that carries the actor's roles; it needs no database while every check that decides is an
 * `actor.is(...)` check (an `Ash.Policy.SimpleCheck`). An actor is tested when the policy checks, in Ash's order,
 * decide it without reaching an `expr` check and the simulator agrees: one the policy (with every other policy of
 * the operation) lets through, and one it keeps out. Reads are left out: Ash allows a read and filters its records,
 * so `Ash.can?` without records answers true for every actor. A case stays a registry task when no declared actor
 * fits, the policy covers only reads, the resource is partitioned by a tenant, or the policy guards fields.
 */
export function policyTests(policy: GraphNode, context: MapContext): Step[] {
    const entity = context.node(parentOf(policy.qn))!;
    const title = lastOf(policy.qn);
    const cases = ['allows permitted actors', 'denies other actors'];
    if (((policy.data.fields ?? []) as string[]).length || partitioned(entity, context)) return testSteps(policy, entity, title, cases, context);
    const wholes = context.children(entity.qn).filter(p => p.kind === 'Policy' && !((p.data.fields ?? []) as string[]).length);
    // Ash allows a read and filters it: without records `Ash.can?` answers true for any read, so reads stay tasks.
    const operations = covered(policy).filter(o => o !== 'read');
    const actors = context.graph.nodes.filter(n => n.kind === 'Actor');
    const verdict = (p: GraphNode, actor: GraphNode) => {
        const ash = ashVerdict(p, actor, context);
        return ash !== undefined && simulator(context).evaluate(p.data.condition as ExprData, { self: {}, actor: { actor: actor.qn, fields: {} } }) === ash ? ash : undefined;
    };
    const allowed = actors.map(actor => ({ actor, operations: operations.filter(o => wholes.filter(p => covered(p).includes(o)).every(p => verdict(p, actor) === true)) }))
        .find(a => verdict(policy, a.actor) === true && a.operations.length);
    const denied = actors.find(actor => verdict(policy, actor) === false);
    const resource = typeModule(entity, context);
    const body = (actor: GraphNode, assertion: 'assert' | 'refute', checked: string[]) => [
        `actor = ${actorStruct(actor, context)}`,
        ...checked.map(o => `${assertion} Ash.can?({${resource}, :${ACTIONS[o]}}, actor, maybe_is: false)`)
    ];
    const tests: TestCase[] = [
        { name: cases[0], body: allowed && body(allowed.actor, 'assert', allowed.operations) },
        { name: cases[1], body: denied && operations.length ? body(denied, 'refute', operations) : undefined }
    ];
    return testSteps(policy, entity, title, tests, context);
}

function covered(policy: GraphNode): string[] {
    const operations = (policy.data.operations ?? []) as string[];
    return operations.length ? operations : Object.keys(ACTIONS);
}

/**
 * The actor as the struct a test passes: a record of its resource with its own roles, or the plain struct of a
 * system or service actor, whose `roles` default to the roles it declares.
 */
function actorStruct(actor: GraphNode, context: MapContext): string {
    const home = homeOf(actor, context);
    if (!home.resource) return `%${home.module}{}`;
    const roles = ((actor.data.roles ?? []) as string[]).map(r => `:${snake(lastOf(r))}`);
    return `%${home.module}{roles: [${roles.join(', ')}]}`;
}

/**
 * How the generated policy decides for the actor, walking its checks the way Ash does: `authorize_if` stops on
 * true, `forbid_unless` stops on false, the end forbids. Undefined once a check is not an `actor.is(...)` check
 * whose answer is known without the record (an `expr` check, a role with a condition). A condition that does not
 * translate became `forbid_if always()`.
 */
function ashVerdict(policy: GraphNode, actor: GraphNode, context: MapContext): boolean | undefined {
    const condition = policy.data.condition as ExprData;
    if (!checkLines(condition, context, false)) return false;
    const branches = split(condition, '||').map(b => split(b, '&&'));
    const steps = [
        ...branches.filter(b => b.length === 1).map(b => ({ check: b[0], authorize: true })),
        ...branches.filter(b => b.length > 1).flatMap(b => b.map((check, i) => ({ check, authorize: i === b.length - 1 })))
    ];
    for (const { check, authorize } of steps) {
        const holds = is(check, actor, context);
        if (holds === undefined) return undefined;
        if (authorize && holds) return true;
        if (!authorize && !holds) return false;
    }
    return false;
}

/** Whether `actor.is(X)` holds for the actor; undefined for any other check and for a role with a condition. */
function is(check: ExprData, actor: GraphNode, context: MapContext): boolean | undefined {
    const named = isTarget(check, context);
    if (!named) return undefined;
    if (named.kind === 'Actor') return named.qn === actor.qn;
    if (named.data.condition) return undefined;
    // The role check matches only on homes whose actors carry the role, and the struct carries the actor's own roles.
    return ((actor.data.roles ?? []) as string[]).includes(named.qn) && rolesOf(homeOf(actor, context)).includes(named.qn);
}

/** Whether the resource is partitioned by a tenant: it relates to a tenant's entity. */
function partitioned(entity: GraphNode, context: MapContext): boolean {
    const tenants = new Set(context.graph.nodes.filter(n => n.kind === 'Tenant').map(n => n.data.entity as string));
    return fieldsOf(entity, context).some(f => {
        const target = relationTarget(f, context);
        return !!target && tenants.has(target.qn);
    });
}

import type { MapContext, Step } from '@appling/codegen';
import type { ExprData, GraphNode } from '@appling/model';
import { homeAt, homeFields, homeOf, homes, rolesOf, type ActorHome } from './actors.js';
import { ashExpr, isActor, lastOf, parentOf } from './elixir.js';
import { calculation, fileOf, moduleName, patch, sectionLines, snake, storedAttributes, task } from './naming.js';
import { addAuthorizer, addToSection } from './resource.js';

const ACTION_TYPES: Record<string, string> = { read: ':read', create: ':create', update: ':update', delete: ':destroy' };

/**
 * One `Ash.Policy.SimpleCheck` per role, with one `match?` clause per actor record that carries the role: the
 * record has the role in its `roles`, the roles the condition names hold, and the rest of the condition holds as
 * the calculation `:<role>?` of the actor resource.
 */
export function roleSteps(role: GraphNode, context: MapContext): Step[] {
    const name = lastOf(role.qn);
    const carriers = homes(context).filter(h => rolesOf(h).includes(role.qn));
    const clauses = carriers.map(home => ({ home, clause: roleClause(role, home, context) }));
    const matching = clauses.flatMap(({ home, clause }) => clause === 'never' || clause === 'unknown' ? [] : [{ module: home.module, checks: clause.checks, calculation: clause.calculation }]);
    const unknown = clauses.filter(c => c.clause === 'unknown').map(c => c.home.module);
    return [
        // Phase 2: the clauses match the actor resources' structs, which exist only once every resource is generated.
        { kind: 'template', file: checkFile(role, context), write: () => `${context.render('access/role-check.ex.njk', { module: checkModule(role, context), description: `actor is ${name}`, role: snake(name), clauses: matching })}\n`, phase: 2 },
        ...(unknown.length ? [task(`check the condition of ${name} for ${unknown.join(', ')} in ${checkModule(role, context)}: ${role.props.condition}`)] : [])
    ];
}

/** A check `<Module>.Checks.<Actor>` for an actor that `actor.is(Actor)` names, when its record tells it apart from other actors. */
export function actorCheckSteps(actor: GraphNode, context: MapContext): Step[] {
    if (!namedActors(context).has(actor.qn)) return [];
    const home = homeOf(actor, context);
    if (home.actors.length > 1) {
        return [task(`tell ${lastOf(actor.qn)} apart from ${home.actors.filter(a => a !== actor).map(a => lastOf(a.qn)).join(', ')} on ${home.module} for actor.is(${lastOf(actor.qn)})`)];
    }
    const data = { module: checkModule(actor, context), description: `actor is ${lastOf(actor.qn)}`, actor: home.module };
    return [{ kind: 'template', file: checkFile(actor, context), write: () => `${context.render('access/actor-check.ex.njk', data)}\n`, phase: 2 }];
}

/** The calculations of an actor resource that hold the role conditions, such as `calculate :operator?, :boolean, expr(active)`. */
export function roleCalculations(node: GraphNode, context: MapContext): string[] {
    const home = homeAt(node, context);
    if (!home?.resource) return [];
    return rolesOf(home).flatMap(qn => {
        const role = context.node(qn);
        const clause = role && roleClause(role, home, context);
        return clause && typeof clause === 'object' && clause.calculation ? [`calculate :${snake(lastOf(qn))}?, :boolean, expr(${clause.calculation})`] : [];
    });
}

/**
 * Whether the generated project enforces policies. A model without any policy keeps its resources open; once one
 * policy exists, nothing is open by default: every resource lists `Ash.Policy.Authorizer` (see `closeResource`).
 */
export function enforced(context: MapContext): boolean {
    return context.graph.nodes.some(n => n.kind === 'Policy');
}

/**
 * A policy whose condition is a `||` of branches, each `actor.is(X)` checks and conditions joined by `&&`,
 * becomes an Ash policy: on its entity's resource for its operations, a field policy for `fields`, or on the
 * read or update action of a query or an action. A condition that does not translate becomes a policy that
 * forbids, plus a task, so nothing opens before the condition is written. Undefined when the target does not translate.
 */
export function policySteps(policy: GraphNode, context: MapContext): Step[] | undefined {
    const owner = context.node(parentOf(policy.qn))!;
    const operations = (policy.data.operations ?? []) as string[];
    const fields = (policy.data.fields ?? []) as string[];
    // Ash field policies name public attributes and calculations only. A derived field without a calculation is not
    // on the resource yet; the field's own task carries this policy (see fieldSteps). A relationship becomes a task.
    const fieldNodes = fields.map(f => context.node(f)).filter(f => f !== undefined);
    const guarded = owner.kind === 'Entity'
        ? fieldNodes.filter(f => storedAttributes(owner, context).has(f.qn) || calculation(f, context)).map(f => f.qn)
        : fields;
    const relations = fieldNodes.filter(f => !f.data.derived && !guarded.includes(f.qn)).map(f => lastOf(f.qn));
    const writes = fields.length > 0 && (!operations.length || operations.some(o => o !== 'read'));
    const extra = [
        ...(relations.length ? [task(`guard reads of the relationship ${relations.join(', ')} on ${parentOf(policy.qn)}, which Ash field policies do not cover: ${policy.props.condition}`)] : []),
        ...(writes ? [task(`guard writes of ${fields.map(lastOf).join(', ')} on ${parentOf(policy.qn)} for ${operations.filter(o => o !== 'read').join(', ') || 'create, update'}, which Ash field policies do not cover: ${policy.props.condition}`)] : [])
    ];
    // Ash field policies guard reads only; a policy on writes alone stays unsupported.
    if (fields.length && !guarded.length) return operations.length && !operations.includes('read') ? undefined : extra;
    const target = policyTarget(owner, operations, guarded, context);
    if (!target) return undefined;
    const checks = checkLines(policy.data.condition as ExprData, context, fields.length > 0);
    const lines = (otherFields: boolean) => sectionLines(context, 'access/policy.ex.njk', { header: target.header, checks: checks ?? [], otherFields });
    return [
        patch(fileOf(target.entity, context), existing => {
            const withPolicy = fields.length
                ? addToSection(existing, 'field_policies', lines(!existing.includes('\n  field_policies do\n')))
                : addToSection(existing, 'policies', lines(false));
            return addAuthorizer(withPolicy);
        }),
        ...(checks ? [] : [policyTask(policy)]),
        ...extra
    ];
}

/** The task for a policy that is not translated. */
export function policyTask(policy: GraphNode): Step {
    return task(`add an Ash policy to ${parentOf(policy.qn)} for ${(policy.data.operations as string[] | undefined)?.join(', ') ?? 'any action'}: ${policy.props.condition}`);
}

/**
 * Closes a resource once the model has a policy: it lists `Ash.Policy.Authorizer`, and when no policy of the model
 * applies to it, such as a resource whose default actions no policy names, a policy that forbids every action.
 * Ash already forbids an action that no policy applies to; the explicit policy states it.
 */
export function closeResource(text: string, node: GraphNode, context: MapContext): string {
    if (!enforced(context)) return text;
    const guarded = context.graph.nodes.some(p => {
        if (p.kind !== 'Policy') return false;
        const target = policyTarget(context.node(parentOf(p.qn))!, (p.data.operations ?? []) as string[], (p.data.fields ?? []) as string[], context);
        return target?.entity.qn === node.qn && target.header.startsWith('policy ');
    });
    return addAuthorizer(guarded ? text : addToSection(text, 'policies', sectionLines(context, 'access/policy.ex.njk', { header: 'policy always()', checks: [], otherFields: false })));
}

function policyTarget(owner: GraphNode, operations: string[], fields: string[], context: MapContext): { entity: GraphNode, header: string } | undefined {
    if (owner.kind === 'Entity' && fields.length) {
        // Ash field policies guard reads only; writes stay a task.
        if (operations.length && !operations.includes('read')) return undefined;
        const names = fields.map(f => `:${lastOf(f)}`);
        return { entity: owner, header: `field_policy ${names.length === 1 ? names[0] : `[${names.join(', ')}]`}` };
    }
    if (owner.kind === 'Entity') {
        const types = operations.map(o => ACTION_TYPES[o]);
        return { entity: owner, header: `policy ${types.length ? `action_type(${types.length === 1 ? types[0] : `[${types.join(', ')}]`})` : 'always()'}` };
    }
    if ((owner.kind === 'Action' || owner.kind === 'Query') && owner.data.entity) {
        if (owner.kind === 'Query' && owner.data.filter && !ashExpr(owner.data.filter as ExprData, context.node)) return undefined;
        return { entity: context.node(owner.data.entity as string)!, header: `policy action(:${snake(lastOf(owner.qn))})` };
    }
    return undefined;
}

/**
 * The checks of a policy body. Branches with one check authorize directly; at most one branch with several checks
 * comes last, as `forbid_unless` for all but its last check, which authorizes.
 */
export function checkLines(condition: ExprData, context: MapContext, field: boolean): string[] | undefined {
    const branches = split(condition, '||').map(b => split(b, '&&').map(c => check(c, context, field)));
    if (branches.some(b => b.some(c => c === undefined))) return undefined;
    const singles = branches.filter(b => b.length === 1) as string[][];
    const several = branches.filter(b => b.length > 1) as string[][];
    if (several.length > 1) return undefined;
    return [
        ...singles.map(b => `authorize_if ${b[0]}`),
        ...several.flatMap(b => [...b.slice(0, -1).map(c => `forbid_unless ${c}`), `authorize_if ${b[b.length - 1]}`])
    ];
}

/** One part of a branch: `actor.is(X)` as X's check module, anything else as an `expr` check. */
function check(expr: ExprData, context: MapContext, field: boolean): string | undefined {
    const named = isTarget(expr, context);
    if (named) return named.kind === 'Role' || (named.kind === 'Actor' && homeOf(named, context).actors.length === 1) ? checkModule(named, context) : undefined;
    // Ash field policies cannot follow relationships in expressions.
    if (field && follows(expr)) return undefined;
    const body = ashExpr(expr, context.node);
    return body && `expr(${body})`;
}

type Clause = { checks: string[], calculation?: string } | 'never' | 'unknown';

/**
 * What it takes for an actor record of `home` to count as `role`. The roles and actors the condition names with
 * `actor.is` are checks (`never` when the home cannot carry them); the rest is a calculation over the record's
 * fields (`never` when the record lacks a field, `unknown` when it does not translate or the home is a struct).
 */
function roleClause(role: GraphNode, home: ActorHome, context: MapContext): Clause {
    const condition = role.data.condition as ExprData | undefined;
    const parts = condition ? split(condition, '&&') : [];
    const checks: string[] = [];
    const rest: ExprData[] = [];
    for (const part of parts) {
        const named = isTarget(part, context);
        if (!named) rest.push(part);
        else if (named.kind === 'Role' && !rolesOf(home).includes(named.qn)) return 'never';
        else if (named.kind === 'Role') checks.push(checkModule(named, context));
        else if (named.kind === 'Actor' && !home.actors.includes(named)) return 'never';
        else if (named.kind === 'Actor' && home.actors.length > 1) return 'unknown';
    }
    if (!rest.length) return { checks };
    if (!home.resource) return 'unknown';
    const fields = new Set(homeFields(home, context).map(f => f.qn));
    const expr = rest.reduce((left, right) => ({ $type: 'BinaryExpr', op: '&&', left, right, type: 'Bool' }));
    if (fieldTargets(expr, context).some(f => !fields.has(f))) return 'never';
    const calculation = ashExpr(onActor(expr), context.node);
    return calculation ? { checks, calculation } : 'unknown';
}

function checkModule(node: GraphNode, context: MapContext): string {
    return `${moduleName(node.module, context)}.Checks.${lastOf(node.qn)}`;
}

function checkFile(node: GraphNode, context: MapContext): string {
    return ['lib', ...fileOf(node, context).split('/').slice(1, -1), 'checks', `${snake(lastOf(node.qn))}.ex`].join('/');
}

/** The role or actor of `actor.is(X)`, or undefined for any other expression. */
export function isTarget(expr: ExprData, context: MapContext): GraphNode | undefined {
    const target = expr.$type === 'MemberExpr' && expr.call && expr.member === 'is' && isActor(expr.receiver) ? expr.args?.[0]?.target : undefined;
    const node = target ? context.node(target) : undefined;
    return node && (node.kind === 'Role' || node.kind === 'Actor') ? node : undefined;
}

/** The actors that some condition names with `actor.is`. */
function namedActors(context: MapContext): Set<string> {
    const names = new Set<string>();
    const visit = (expr: ExprData | undefined): void => {
        if (!expr) return;
        const named = isTarget(expr, context);
        if (named?.kind === 'Actor') names.add(named.qn);
        for (const child of children(expr)) visit(child);
    };
    for (const node of context.graph.nodes) if (node.kind === 'Role' || node.kind === 'Policy') visit(node.data.condition as ExprData | undefined);
    return names;
}

export function split(expr: ExprData, op: '&&' | '||'): ExprData[] {
    return expr.$type === 'BinaryExpr' && expr.op === op ? [...split(expr.left!, op), ...split(expr.right!, op)] : [expr];
}

function children(expr: ExprData): ExprData[] {
    return [expr.left, expr.right, expr.operand, expr.receiver, expr.index, ...(expr.args ?? []), ...(expr.items ?? [])].filter((e): e is ExprData => !!e);
}

/** Whether an expression follows a relationship of the record, such as `buyer.company`. */
function follows(expr: ExprData): boolean {
    return (expr.$type === 'MemberExpr' && !expr.call && !isActor(expr.receiver)) || children(expr).some(follows);
}

function fieldTargets(expr: ExprData, context: MapContext): string[] {
    const own = expr.target && context.node(expr.target)?.kind === 'Field' ? [expr.target] : [];
    return [...own, ...children(expr).flatMap(c => fieldTargets(c, context))];
}

/** The role condition as an expression on the actor resource itself, where `actor.active` is the attribute `active`. */
function onActor(expr: ExprData): ExprData {
    if (expr.$type === 'MemberExpr' && !expr.call && isActor(expr.receiver)) {
        return { $type: 'NameExpr', name: expr.member, type: expr.type, target: expr.target };
    }
    const mapped: ExprData = { ...expr };
    for (const key of ['left', 'right', 'operand', 'receiver', 'index'] as const) if (expr[key]) mapped[key] = onActor(expr[key]);
    for (const key of ['args', 'items'] as const) if (expr[key]) mapped[key] = expr[key].map(onActor);
    return mapped;
}

/** Whether a policy becomes an Ash policy with its own checks, not one that forbids until a person writes it. */
export function policyTranslates(policy: GraphNode, context: MapContext): boolean {
    const owner = context.node(parentOf(policy.qn))!;
    const fields = (policy.data.fields ?? []) as string[];
    return !!policyTarget(owner, (policy.data.operations ?? []) as string[], fields, context)
        && !!checkLines(policy.data.condition as ExprData, context, fields.length > 0);
}

/**
 * Whether the checks a condition names with `actor.is` answer for a record of `home` as the model does: no role
 * check of the home leaves its condition to a task, also for the roles that role conditions name in turn.
 */
export function checksAnswer(condition: ExprData | undefined, home: ActorHome, context: MapContext, seen = new Set<string>()): boolean {
    if (!condition) return true;
    const named = isTarget(condition, context);
    if (named?.kind === 'Role' && !seen.has(named.qn)) {
        seen.add(named.qn);
        if (rolesOf(home).includes(named.qn) && roleClause(named, home, context) === 'unknown') return false;
        if (!checksAnswer(named.data.condition as ExprData | undefined, home, context, seen)) return false;
    }
    return children(condition).every(c => checksAnswer(c, home, context, seen));
}

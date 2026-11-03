import type { MapContext, Step } from '@appling/codegen';
import type { ExprData, GraphNode } from '@appling/model';
import { ashExpr, lastOf, parentOf } from './elixir.js';
import { fileOf, moduleName, patch, snake, task, typeModule } from './naming.js';
import { addAuthorizer, addToSection } from './resource.js';

const ACTION_TYPES: Record<string, string> = { read: ':read', create: ':create', update: ':update', delete: ':destroy' };

/** The entity the actors are bound to with `is`, whose resource is the actor; undefined unless there is exactly one. */
export function userEntity(context: MapContext): GraphNode | undefined {
    const bound = new Set(context.graph.nodes.filter(n => n.kind === 'Actor' && n.data.entity).map(n => n.data.entity as string));
    return bound.size === 1 ? context.node([...bound][0]) : undefined;
}

/** One `Ash.Policy.SimpleCheck` per role: the actor has the role in its `roles` and the role's condition holds. */
export function roleSteps(role: GraphNode, context: MapContext): Step[] {
    const name = lastOf(role.qn);
    const user = userEntity(context);
    if (!user) return [task(`model the role ${name} on the actor resource`)];
    const condition = roleCondition(role, context);
    const holds = [`:${snake(name)} in (actor.roles || [])`, ...(condition ? [`actor.${snake(name)}?`] : [])].join(' and ');
    const code = [
        `defmodule ${checkModule(role, context)} do`,
        '  use Ash.Policy.SimpleCheck',
        '',
        '  @impl true',
        `  def describe(_opts), do: ${JSON.stringify(`actor is ${name}`)}`,
        '',
        '  @impl true',
        `  def match?(%${typeModule(user, context)}{} = actor, _context, _opts) do`,
        ...(condition ? [`    actor = Ash.load!(actor, :${snake(name)}?, authorize?: false)`] : []),
        `    ${holds}`,
        '  end',
        '',
        '  def match?(_actor, _context, _opts), do: false',
        'end',
        ''
    ].join('\n');
    const file = ['lib', ...fileOf(role, context).split('/').slice(1, -1), 'checks', `${snake(name)}.ex`].join('/');
    return [
        { kind: 'template', file, write: () => code },
        ...(role.data.condition && !condition ? [task(`check the condition of ${name} in ${checkModule(role, context)}: ${role.props.condition}`)] : [])
    ];
}

/** The calculations of the actor resource that hold the role conditions, such as `calculate :operator?, :boolean, expr(active)`. */
export function roleCalculations(entity: GraphNode, context: MapContext): string[] {
    if (userEntity(context)?.qn !== entity.qn) return [];
    return context.graph.nodes.filter(n => n.kind === 'Role').flatMap(role => {
        const condition = roleCondition(role, context);
        return condition ? [`calculate :${snake(lastOf(role.qn))}?, :boolean, expr(${condition})`] : [];
    });
}

/**
 * A policy whose condition only names roles (`actor.is(A) || actor.is(B)`) becomes an Ash policy with one
 * `authorize_if` per role check, on the entity's resource or on the action. Undefined for any other policy.
 */
export function rolePolicySteps(policy: GraphNode, context: MapContext): Step[] | undefined {
    const owner = context.node(parentOf(policy.qn))!;
    const checks = userEntity(context) && roleChecks(policy.data.condition as ExprData, context);
    if (!checks) return undefined;
    const operations = (policy.data.operations ?? []) as string[];
    const target = owner.kind === 'Entity' && !(policy.data.fields as string[] | undefined)?.length
        ? { entity: owner, condition: operations.length ? `action_type(${operations.length === 1 ? ACTION_TYPES[operations[0]] : `[${operations.map(o => ACTION_TYPES[o]).join(', ')}]`})` : 'always()' }
        : owner.kind === 'Action' && owner.data.entity
            ? { entity: context.node(owner.data.entity as string)!, condition: `action(:${snake(lastOf(owner.qn))})` }
            : undefined;
    if (!target) return undefined;
    const lines = [`policy ${target.condition} do`, ...checks.map(c => `  authorize_if ${c}`), 'end'];
    return [patch(fileOf(target.entity, context), existing => addAuthorizer(addToSection(existing, 'policies', lines)))];
}

function checkModule(role: GraphNode, context: MapContext): string {
    return `${moduleName(role.module, context)}.Checks.${lastOf(role.qn)}`;
}

/** The check modules of `actor.is(Role)` branches joined by `||`, or undefined when the condition says anything else. */
function roleChecks(expr: ExprData, context: MapContext): string[] | undefined {
    if (expr.$type === 'BinaryExpr' && expr.op === '||') {
        const [left, right] = [roleChecks(expr.left!, context), roleChecks(expr.right!, context)];
        return left && right && [...left, ...right];
    }
    const role = expr.$type === 'MemberExpr' && expr.call && expr.member === 'is' && expr.receiver?.name === 'actor' && !expr.receiver.target && expr.args?.[0]?.target
        ? context.node(expr.args[0].target)
        : undefined;
    return role?.kind === 'Role' ? [checkModule(role, context)] : undefined;
}

/** The role condition as an expression on the actor resource itself, where `actor.active` is the attribute `active`. */
function roleCondition(role: GraphNode, context: MapContext): string | undefined {
    const condition = role.data.condition as ExprData | undefined;
    return condition && ashExpr(onActor(condition), context.node);
}

function onActor(expr: ExprData): ExprData {
    if (expr.$type === 'MemberExpr' && !expr.call && expr.receiver?.$type === 'NameExpr' && expr.receiver.name === 'actor' && !expr.receiver.target) {
        return { $type: 'NameExpr', name: expr.member, type: expr.type, target: expr.target };
    }
    const mapped: ExprData = { ...expr };
    for (const key of ['left', 'right', 'operand', 'receiver', 'index'] as const) if (expr[key]) mapped[key] = onActor(expr[key]);
    for (const key of ['args', 'items'] as const) if (expr[key]) mapped[key] = expr[key].map(onActor);
    return mapped;
}

import type { MapContext, Step } from '@appling/codegen';
import type { ExprData, GraphNode, TypeData } from '@appling/model';
import { children, importOnReady, pythonFile, task, template } from './files.js';
import { actorFields, actorUserSteps, scope, storedFields, userModel } from './models.js';
import { testSteps } from './tests.js';
import { appOf, lastOf, parentOf, python, rolePredicate, snake, tenantGetter, wrap, type PythonScope } from './python.js';

const OPERATIONS = ['read', 'create', 'update', 'delete'] as const;
type Operation = typeof OPERATIONS[number];

const NOBODY = 'models.Q(pk__in=[])';
/** Matches every row; an empty `models.Q()` would vanish when combined with `|`. */
const EVERYBODY = 'models.Q(pk__isnull=False)';

/**
 * Whether the generated code enforces policies. A model without any policy keeps the code it had before access
 * was generated; once one policy exists, everything follows the model's rule that nothing is open by default.
 */
export function enforced(context: MapContext): boolean {
    return context.graph.nodes.some(n => n.kind === 'Policy');
}

/** The Django groups of a module's roles and actors, created after `migrate` by a `post_migrate` receiver in `<app>/groups.py`. */
function groupStep(node: GraphNode): Step[] {
    const app = appOf(node.module);
    const name = JSON.stringify(lastOf(node.qn));
    return [
        template(`${app}/groups.py`, existing => existing
            ? existing.replace(/GROUPS = \[\n([\s\S]*?)\]/, (_, names) => `GROUPS = [\n${names}    ${name},\n]`)
            : pythonFile(undefined, ['from django.contrib.auth.models import Group', 'from django.db.models.signals import post_migrate', 'from django.dispatch import receiver'], GROUPS.replace('{names}', `    ${name},\n`))),
        importOnReady(node.module, 'groups')
    ];
}

const GROUPS = `GROUPS = [
{names}]


@receiver(post_migrate)
def create_groups(sender, **kwargs) -> None:
    """Creates the Django groups of the module's roles and actors."""
    for name in GROUPS:
        Group.objects.get_or_create(name=name)`;

/**
 * One django-rules predicate per role: the user is in the role's group or in the group of an actor that carries
 * the role, and the role's condition holds.
 */
export function roleSteps(role: GraphNode, context: MapContext): Step[] {
    const name = lastOf(role.qn);
    const imports = new Set(['import rules']);
    const carriers = context.graph.nodes.filter(n => n.kind === 'Actor' && ((n.data.roles ?? []) as string[]).includes(role.qn)).map(n => lastOf(n.qn));
    const names = [name, ...carriers].map(n => JSON.stringify(n));
    const group = `user is not None and user.groups.filter(${names.length === 1 ? `name=${names[0]}` : `name__in=[${names.join(', ')}]`}).exists()`;
    const condition = role.data.condition ? python(role.data.condition as ExprData, { ...scope(context, imports), actor: 'user' }) : undefined;
    const code = ['@rules.predicate', `def ${rolePredicate(role)}(user):`, `    return ${condition ? `${group} and ${wrap(condition)}` : group}`].join('\n');
    return [
        template(`${appOf(role.module)}/roles.py`, existing => pythonFile(existing, imports, code)),
        ...groupStep(role),
        ...(role.data.condition && !condition ? [task(`check the condition of ${name} in ${rolePredicate(role)}: ${role.props.condition}`)] : [])
    ];
}

/**
 * An actor becomes a Django group and a predicate `is_<actor>(user)` in `<app>/actors.py`, for `actor.is(Actor)`.
 * Its fields live on the user model; without a bound entity the first actor with fields declares that model.
 */
export function actorSteps(actor: GraphNode, context: MapContext): Step[] {
    const code = ['@rules.predicate', `def ${rolePredicate(actor)}(user):`, `    return user is not None and user.groups.filter(name=${JSON.stringify(lastOf(actor.qn))}).exists()`].join('\n');
    const user = userModel(context);
    return [
        template(`${appOf(actor.module)}/actors.py`, existing => pythonFile(existing, ['import rules'], code)),
        ...groupStep(actor),
        ...(user?.owner === actor ? actorUserSteps(user, context) : [])
    ];
}

/**
 * A tenant becomes `<app>/tenants.py`: a context variable with the current tenant, read by `current_<tenant>()`,
 * and a middleware in `MIDDLEWARE` that sets it per request from the signed in user.
 */
export function tenantSteps(tenant: GraphNode, context: MapContext): Step[] {
    const app = appOf(tenant.module);
    const name = lastOf(tenant.qn);
    const variable = `_${snake(name)}`;
    const entity = context.node(tenant.data.entity as string)!;
    const resolve = tenantOfUser(entity, context);
    const middleware = `${name}Middleware`;
    const code = [
        'from contextvars import ContextVar',
        '',
        '',
        `${variable}: ContextVar = ContextVar(${JSON.stringify(snake(name))}, default=None)`,
        '',
        '',
        `def ${tenantGetter(tenant)}():`,
        `    """The ${lastOf(entity.qn)} that is the current tenant, or None outside a request."""`,
        `    return ${variable}.get()`,
        '',
        '',
        `class ${middleware}:`,
        `    """Sets the current tenant for each request${resolve ? `: ${resolve.description}` : ''}."""`,
        '',
        '    def __init__(self, get_response):',
        '        self.get_response = get_response',
        '',
        '    def __call__(self, request):',
        `        token = ${variable}.set(${resolve?.code ?? 'None'})`,
        '        try:',
        '            return self.get_response(request)',
        '        finally:',
        `            ${variable}.reset(token)`,
        ''
    ].join('\n');
    const line = `${JSON.stringify(`${app}.tenants.${middleware}`)},`;
    return [
        template(`${app}/tenants.py`, () => code),
        template('config/settings.py', existing => existing!.includes(line) ? existing! : /MIDDLEWARE = \[\n[\s\S]*?\]/.test(existing!)
            ? existing!.replace(/MIDDLEWARE = \[\n([\s\S]*?)\]/, (_, items) => `MIDDLEWARE = [\n${items}    ${line}\n]`)
            : `${existing!.trimEnd()}\n\nMIDDLEWARE = [\n    ${line}\n]\n`),
        ...(resolve ? [] : [task(`set the tenant ${name} (a ${lastOf(entity.qn)}) of each request in ${middleware}`)])
    ];
}

/** How a request finds its tenant: the user is the tenant entity, or the user model has a field of its type. */
function tenantOfUser(entity: GraphNode, context: MapContext): { code: string, description: string } | undefined {
    const user = userModel(context);
    if (user?.entity?.qn === entity.qn) return { code: 'request.user if request.user.is_authenticated else None', description: 'the signed in user' };
    const fields = [...(user?.entity ? children(user.entity, context, 'Field') : []), ...actorFields(context)];
    const field = fields.find(f => !f.data.derived && !(f.data.type as TypeData).many && (f.data.type as TypeData).decl === entity.qn);
    return field && { code: `getattr(request.user, ${JSON.stringify(lastOf(field.qn))}, None)`, description: `the ${lastOf(field.qn)} of the signed in user` };
}

/**
 * A policy is enforced where its element is used (see `entityPolicySteps`, `actionGuard`, `queryGuard`,
 * `useCaseGuard`); it stays a task when its condition has no Python translation, and a field policy also for writes.
 */
export function policySteps(policy: GraphNode, context: MapContext): Step[] {
    const operations = (policy.data.operations ?? []) as string[];
    const fields = ((policy.data.fields ?? []) as string[]).map(lastOf);
    const label = `${operations.length ? operations.join(', ') : 'any'}${fields.length ? ` (fields ${fields.join(', ')})` : ''}`;
    const tasks: Step[] = [];
    if (!policyCondition(policy, context, new Set())) tasks.push(task(`enforce the ${label} policy of ${parentOf(policy.qn)}: ${policy.props.condition}`));
    else if (fields.length && operations.some(o => o !== 'read') || fields.length && !operations.length) {
        tasks.push(task(`enforce the ${label} policy of ${parentOf(policy.qn)} on writes: ${policy.props.condition}`));
    }
    return [...tasks, ...testSteps(policy, String(policy.props.condition), ['allows_permitted_actors', 'denies_other_actors'], context)];
}

/** The variable holding the guarded record in the code that checks a policy of this element. */
function recordOf(element: GraphNode, context: MapContext): string | undefined {
    if (element.kind === 'Entity') return snake(lastOf(element.qn));
    if (element.kind === 'Action') return element.data.entity ? snake(lastOf(element.data.entity as string)) : undefined;
    if (element.kind === 'Query') return 'row';
    return undefined;
}

/** A policy's condition in Python, with `actor` as the actor and the guarded record in its usual variable. */
export function policyCondition(policy: GraphNode, context: MapContext, imports: Set<string>): string | undefined {
    const element = context.node(parentOf(policy.qn))!;
    return python(policy.data.condition as ExprData, { ...scope(context, imports), self: recordOf(element, context), actor: 'actor' });
}

function policiesOf(element: GraphNode, context: MapContext): GraphNode[] {
    return children(element, context, 'Policy');
}

function covers(policy: GraphNode, operation: Operation): boolean {
    const operations = (policy.data.operations ?? []) as string[];
    return !operations.length || operations.includes(operation);
}

function guardedFields(policy: GraphNode): string[] {
    return (policy.data.fields ?? []) as string[];
}

export function canName(entity: GraphNode, operation: Operation): string {
    return `can_${operation}_${snake(lastOf(entity.qn))}`;
}

export function canReadField(field: GraphNode): string {
    return `can_read_${snake(lastOf(parentOf(field.qn)))}_${lastOf(field.qn)}`;
}

export function readableName(entity: GraphNode): string {
    return `readable_${snake(lastOf(entity.qn))}_rows`;
}

/** Imports a function of the entity's `policies.py`. */
export function policyImport(entity: GraphNode, name: string, imports: Set<string>): string {
    imports.add(`from ${appOf(entity.module)}.policies import ${name}`);
    return name;
}

/**
 * The policies of an entity become functions in `<app>/policies.py`: `can_<operation>_<entity>(actor, record)` per
 * operation (the conjunction of the policies that cover it, False when none does), `can_read_<entity>_<field>` per
 * field with a read policy, and `readable_<entity>_rows(actor, rows)` that narrows a queryset to the readable rows.
 */
export function entityPolicySteps(entity: GraphNode, context: MapContext): Step[] {
    if (!enforced(context)) return [];
    const imports = new Set<string>();
    const record = recordOf(entity, context)!;
    const policies = policiesOf(entity, context);
    const blocks: string[] = [];
    const whole = (operation: Operation) => policies.filter(p => !guardedFields(p).length && covers(p, operation));
    for (const operation of OPERATIONS) {
        const covering = whole(operation);
        const conditions = covering.map(p => policyCondition(p, context, imports));
        const head = `def ${canName(entity, operation)}(actor, ${record}) -> bool:`;
        if (!covering.length) blocks.push([head, `    return False  # no policy grants ${operation}`].join('\n'));
        else if (conditions.some(c => !c)) blocks.push([head, `    return False  # see the registry task of ${covering[conditions.findIndex(c => !c)].qn}`].join('\n'));
        else blocks.push([head, '    if not getattr(actor, "is_authenticated", False):', '        return False', `    return ${conjunction(conditions as string[])}`].join('\n'));
    }
    const fields = new Map<string, GraphNode[]>();
    for (const policy of policies.filter(p => guardedFields(p).length && covers(p, 'read'))) {
        for (const field of guardedFields(policy)) fields.set(field, [...(fields.get(field) ?? []), policy]);
    }
    for (const [qn, guards] of fields) {
        const conditions = guards.map(p => policyCondition(p, context, imports));
        const body = conditions.some(c => !c) ? 'False' : conjunction([`${canName(entity, 'read')}(actor, ${record})`, ...conditions as string[]]);
        blocks.push([`def ${canReadField(context.node(qn)!)}(actor, ${record}) -> bool:`, `    return ${body}`].join('\n'));
    }
    const reads = whole('read');
    const filters = reads.map(p => policyQ(p.data.condition as ExprData, entity, context, imports));
    const narrowed = !reads.length || reads.some((p, i) => !policyCondition(p, context, new Set()) && !filters[i])
        ? 'rows.none()'
        : filters.every(f => f)
            ? `rows.filter(${filters.length === 1 ? filters[0] : filters.map(f => `(${f})`).join(' & ')})`
            : `rows.filter(pk__in=[${record}.pk for ${record} in rows if ${canName(entity, 'read')}(actor, ${record})])`;
    if (narrowed.includes('models.')) imports.add('from django.db import models');
    blocks.push([
        `def ${readableName(entity)}(actor, rows):`,
        `    """Narrows a queryset of ${lastOf(entity.qn)} to the rows the actor may read."""`,
        '    if not getattr(actor, "is_authenticated", False):',
        '        return rows.none()',
        `    return ${narrowed}`
    ].join('\n'));
    return [template(`${appOf(entity.module)}/policies.py`, existing => pythonFile(existing, imports, blocks.join('\n\n\n')))];
}

function conjunction(conditions: string[]): string {
    return conditions.length === 1 ? conditions[0] : conditions.map(wrap).join(' and ');
}

/**
 * The check an action, a use case or a query runs first: raise `PermissionDenied` unless the actor passes. Code that
 * calls without an actor (`actor=None`, as jobs and receivers do) runs as the system and is not checked.
 */
export function actionGuard(action: GraphNode, context: MapContext, pyScope: PythonScope): string[] {
    if (!enforced(context)) return [];
    const conditions: string[] = [];
    const entity = action.data.entity ? context.node(action.data.entity as string) : undefined;
    if (entity) conditions.push(`${policyImport(entity, canName(entity, 'update'), pyScope.imports)}(actor, ${pyScope.self})`);
    for (const policy of policiesOf(action, context)) conditions.push(python(policy.data.condition as ExprData, pyScope) ?? 'False');
    const transitions = context.graph.nodes.filter(n => n.kind === 'Transition' && n.data.action === action.qn);
    const creates = [action, ...transitions].some(n => context.children(n.qn).some(c => c.kind === 'CreateEffect'));
    if (!conditions.length && creates) return [];
    return denyUnless(conditions, lastOf(action.qn), pyScope.imports);
}

export function useCaseGuard(useCase: GraphNode, context: MapContext, pyScope: PythonScope): string[] {
    const policies = policiesOf(useCase, context);
    if (!enforced(context) || !policies.length) return [];
    return denyUnless(policies.map(p => python(p.data.condition as ExprData, pyScope) ?? 'False'), lastOf(useCase.qn), pyScope.imports);
}

function denyUnless(conditions: string[], label: string, imports: Set<string>): string[] {
    imports.add('from django.core.exceptions import PermissionDenied');
    const raise = `    raise PermissionDenied(${JSON.stringify(label)})`;
    if (!conditions.length || conditions.includes('False')) return ['if actor is not None:', raise];
    return [`if actor is not None and not (${conjunction(['actor.is_authenticated', ...conditions])}):`, raise];
}

/** Lines that create a record and check the created entity's `create` policies before saving it. */
export function guardedCreate(entity: GraphNode, args: string, label: string, context: MapContext, imports: Set<string>): string[] {
    const check = policyImport(entity, canName(entity, 'create'), imports);
    imports.add('from django.core.exceptions import PermissionDenied');
    return [
        `created = ${lastOf(entity.qn)}(${args})`,
        `if actor is not None and not ${check}(actor, created):`,
        `    raise PermissionDenied(${JSON.stringify(label)})`,
        'created.save()'
    ];
}

/** The lines of a query function after `rows` is built: the entity's read policies and the query's own, for the given actor. */
export function queryGuard(query: GraphNode, context: MapContext, imports: Set<string>): string[] {
    if (!enforced(context)) return [];
    const entity = context.node(query.data.entity as string)!;
    const lines = ['if actor is None:', '    return rows', 'if not actor.is_authenticated:', '    return rows.none()', `rows = ${policyImport(entity, readableName(entity), imports)}(actor, rows)`];
    for (const policy of policiesOf(query, context)) {
        const filter = policyQ(policy.data.condition as ExprData, entity, context, imports);
        if (filter) {
            imports.add('from django.db import models');
            lines.push(`rows = rows.filter(${filter})`);
            continue;
        }
        const condition = policyCondition(policy, context, imports);
        lines.push(condition ? `rows = rows.filter(pk__in=[row.pk for row in rows if ${condition}])` : 'return rows.none()');
        if (!condition) break;
    }
    return lines;
}

/** The read guard of each guarded field of an entity, by field name. */
export function fieldGuards(entity: GraphNode, context: MapContext): Map<string, string> {
    const guards = new Map<string, string>();
    if (!enforced(context)) return guards;
    for (const policy of policiesOf(entity, context).filter(p => covers(p, 'read'))) {
        for (const field of guardedFields(policy)) guards.set(lastOf(field), canReadField(context.node(field)!));
    }
    return guards;
}

/**
 * A policy condition as a `models.Q` over the rows of an entity, or undefined. Parts that do not read the row, such
 * as `actor.is(Clerk)`, are evaluated once and become a Q that matches every row or none; comparisons of a row path
 * (`customer`, `buyer.company`) with such a value become lookups.
 */
export function policyQ(expr: ExprData, entity: GraphNode, context: MapContext, imports: Set<string>): string | undefined {
    const pyScope: PythonScope = { ...scope(context, imports), actor: 'actor' };
    const stored = storedFields(entity, context);
    const value = (e: ExprData) => python(e, pyScope);
    const sub = (e: ExprData) => policyQ(e, entity, context, imports);
    const path = (e: ExprData | undefined): string | undefined => {
        if (!e || e.call) return undefined;
        if (e.$type === 'NameExpr' && e.name === 'this' && !e.target) return 'pk';
        if (e.$type === 'NameExpr') return e.target && stored.has(e.target) ? e.name : undefined;
        if (e.$type !== 'MemberExpr' || !e.target) return undefined;
        const field = context.node(e.target);
        const receiver = path(e.receiver);
        if (!receiver || field?.kind !== 'Field' || context.node(parentOf(field.qn))?.kind !== 'Entity' || field.data.derived || (field.data.type as TypeData).many) return undefined;
        return `${receiver}__${e.member}`;
    };
    const constant = value(expr);
    if (constant) return `(${EVERYBODY} if ${wrap(constant)} else ${NOBODY})`;
    if (expr.$type === 'BinaryExpr' && (expr.op === '&&' || expr.op === '||')) {
        const [left, right] = [sub(expr.left!), sub(expr.right!)];
        return left && right && `(${left}) ${expr.op === '&&' ? '&' : '|'} (${right})`;
    }
    if (expr.$type === 'UnaryExpr' && expr.op === '!') {
        const operand = sub(expr.operand!);
        return operand && `~(${operand})`;
    }
    if (path(expr) && (context.node(expr.target!)?.data.type as TypeData).primitive === 'Bool') return `models.Q(${path(expr)}=True)`;
    if (expr.$type === 'NameExpr' && expr.call && expr.name === 'has' && path(expr.args?.[0])) return `models.Q(${path(expr.args![0])}__isnull=False)`;
    if (expr.$type !== 'BinaryExpr') return undefined;
    if (expr.op === 'in') {
        const values = path(expr.left) && value(expr.right!);
        return values ? `models.Q(${path(expr.left)}__in=${values})` : undefined;
    }
    const flipped: Record<string, string> = { '<': '>', '<=': '>=', '>': '<', '>=': '<=', '==': '==', '!=': '!=' };
    const lookups: Record<string, string> = { '==': '', '<': '__lt', '<=': '__lte', '>': '__gt', '>=': '__gte' };
    const [name, other, op] = path(expr.left) ? [path(expr.left)!, expr.right!, expr.op!] : path(expr.right) ? [path(expr.right)!, expr.left!, flipped[expr.op!]] : [];
    if (!name || !other || !op) return undefined;
    const v = path(other) ? `models.F(${JSON.stringify(path(other))})` : name === 'pk' ? value(other) && `getattr(${value(other)}, "pk", None)` : value(other);
    if (v === undefined) return undefined;
    if (v === 'None' && (op === '==' || op === '!=')) return `models.Q(${name}__isnull=${op === '==' ? 'True' : 'False'})`;
    if (op === '!=') return `~models.Q(${name}=${v})`;
    return op in lookups ? `models.Q(${name}${lookups[op]}=${v})` : undefined;
}

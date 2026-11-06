import type { MapContext, Step } from '@appling/codegen';
import type { ExprData, GraphNode, TypeData } from '@appling/model';
import { goExpr, pascal, PRIMITIVES, type GoAccess, type GoScope } from './golang.js';

/**
 * The access package: `Actor` (who acts, with its roles, tenant and the fields the actors declare), the role
 * and actor constants, one `Is<Role>` check per role, and the tenant helpers. It has no imports from the model's
 * packages, so every module package can import it; fields that hold records hold their ID.
 */
export function accessOf(context: MapContext): GoAccess {
    const pkg = context.graph.nodes.some(n => n.kind === 'Module' && n.qn === 'access') ? 'accessctl' : 'access';
    return { pkg, path: `${context.name}/internal/${pkg}`, name: qn => uniqueName(qn, context) };
}

/** The tenant when the workspace declares exactly one; only then does `tenant` mean something. */
export function tenantOf(context: MapContext): GraphNode | undefined {
    const tenants = context.graph.nodes.filter(n => n.kind === 'Tenant');
    return tenants.length === 1 ? tenants[0] : undefined;
}

/**
 * The entities that belong to the tenant, each with the fields that lead from it to the tenant's entity:
 * the entity itself (no fields), and every entity with a single, not list, reference to one that belongs.
 */
export function tenantPaths(context: MapContext): Map<string, GraphNode[]> {
    const tenant = tenantOf(context);
    const paths = new Map<string, GraphNode[]>();
    if (!tenant) return paths;
    paths.set(tenant.data.entity as string, []);
    const entities = context.graph.nodes.filter(n => n.kind === 'Entity');
    for (let changed = true; changed;) {
        changed = false;
        const round = new Map<string, GraphNode[]>();
        for (const entity of entities) {
            if (paths.has(entity.qn)) continue;
            const field = context.children(entity.qn).find(f => {
                const type = f.data.type as TypeData | undefined;
                return f.kind === 'Field' && !f.data.derived && type?.decl && !type.many && paths.has(type.decl);
            });
            if (field) round.set(entity.qn, [field, ...paths.get((field.data.type as TypeData).decl!)!]);
        }
        for (const [qn, path] of round) { paths.set(qn, path); changed = true; }
    }
    return paths;
}

/** The fields of the `Actor` struct by name: those the actors declare, then those of the entities they are stored as. */
export function actorFields(context: MapContext): GraphNode[] {
    const actors = context.graph.nodes.filter(n => n.kind === 'Actor');
    const fields = new Map<string, GraphNode>();
    for (const field of [
        ...actors.flatMap(a => context.children(a.qn).filter(c => c.kind === 'Field')),
        ...actors.flatMap(a => a.data.entity ? context.children(a.data.entity as string).filter(c => c.kind === 'Field') : [])
    ]) {
        const name = last(field.qn);
        if (!fields.has(name) && !['type', 'roles', 'id', 'tenant'].includes(name)) fields.set(name, field);
    }
    return [...fields.values()];
}

/** The Go type of an actor field: pointers, so a field is nil for actors without it; records by ID. Undefined for enums and value types. */
export function actorFieldType(field: GraphNode, context: MapContext, imports: Set<string>): string | undefined {
    const type = field.data.type as TypeData;
    let base: string;
    if (type.primitive) {
        const [name, pkg] = PRIMITIVES[type.primitive];
        if (pkg) imports.add(pkg);
        base = name;
    } else if (context.node(type.decl!)?.kind === 'Entity') base = 'int64';
    else return undefined;
    return type.many ? `[]${base}` : `*${base}`;
}

/** The steps of a role, actor or tenant: the whole access file (each writes the same), plus tasks for what it cannot say. */
export function accessSteps(node: GraphNode, context: MapContext): Step[] {
    const access = accessOf(context);
    const steps: Step[] = [accessFile(context, access)];
    if (node.kind === 'Role' && node.data.condition && !roleCondition(node, context, access, new Set())) {
        steps.push({ kind: 'task', what: `check the condition of ${last(node.qn)} in ${access.pkg}.Is${access.name(node.qn)}: ${node.props.condition}` });
    }
    if (node.kind === 'Tenant' && !tenantOf(context)) {
        steps.push({ kind: 'task', what: `decide how the tenant ${last(node.qn)} scopes the records; with several tenants, the generated Actor has no Tenant` });
    }
    return steps;
}

export function accessFile(context: MapContext, access: GoAccess): Step {
    return { kind: 'template', file: `internal/${access.pkg}/${access.pkg}.go`, write: () => accessCode(context, access) };
}

function accessCode(context: MapContext, access: GoAccess): string {
    const imports = new Set(['errors', 'slices']);
    const roles = context.graph.nodes.filter(n => n.kind === 'Role');
    const actors = context.graph.nodes.filter(n => n.kind === 'Actor');
    const tenant = tenantOf(context);
    const tenantEntity = tenant && (tenant.data.entity as string);
    const blocks: string[] = [
        '// ErrForbidden is returned by an action when its policies do not grant it to the actor.\nvar ErrForbidden = errors.New("forbidden")',
        `// Role is a role of the model, by qualified name.\ntype Role string${roles.length ? `\n\nconst (\n${roles.map(r => `\t// Role${access.name(r.qn)} is the role ${r.qn}.\n\tRole${access.name(r.qn)} Role = ${JSON.stringify(r.qn)}`).join('\n')}\n)` : ''}`,
        `// ActorType is a declared actor of the model, by qualified name.\ntype ActorType string${actors.length ? `\n\nconst (\n${actors.map(a => `\t// Actor${access.name(a.qn)} is the ${a.data.kind} actor ${a.qn}.\n\tActor${access.name(a.qn)} ActorType = ${JSON.stringify(a.qn)}`).join('\n')}\n)` : ''}`
    ];
    const fields = actorFields(context).flatMap(field => {
        const type = actorFieldType(field, context, imports);
        if (!type) return [];
        const owner = parentOf(field.qn);
        const record = (field.data.type as TypeData).decl ? `, the ID of a ${(field.data.type as TypeData).decl}` : '';
        return [`\t// ${pascal(last(field.qn))} is the field ${last(field.qn)} of ${owner}${record}.`, `\t${pascal(last(field.qn))} ${type} \`json:"${last(field.qn)}"\``];
    });
    blocks.push([
        '// Actor is who acts: a declared actor with the roles it carries, the tenant it acts in, and the fields',
        '// the actors declare. A field is nil for actors that do not declare it; fields that hold records hold their ID.',
        'type Actor struct {',
        '\tType  ActorType `json:"type"`',
        '\tRoles []Role    `json:"roles"`',
        '\t// ID is the record the actor is stored as, for actors declared with `is`.',
        '\tID *int64 `json:"id"`',
        ...(tenant ? [`\t// Tenant is the ID of the ${tenantEntity} the actor acts in (the tenant ${tenant.qn}); nil when it acts across tenants.`, '\tTenant *int64 `json:"tenant"`'] : []),
        ...fields,
        '}'
    ].join('\n'));
    for (const actor of actors) {
        const name = access.name(actor.qn);
        const roleList = ((actor.data.roles ?? []) as string[]).map(r => `Role${access.name(r)}`).join(', ');
        blocks.push(`// New${name} returns the actor ${actor.qn} with the roles it declares.\nfunc New${name}() Actor {\n\treturn Actor{Type: Actor${name}, Roles: []Role{${roleList}}}\n}`);
    }
    blocks.push('// Has reports whether the actor carries the role, without checking the role\'s condition.\nfunc (a Actor) Has(role Role) bool {\n\treturn slices.Contains(a.Roles, role)\n}');
    for (const role of roles) {
        const name = access.name(role.qn);
        const condition = role.data.condition ? roleCondition(role, context, access, imports) : undefined;
        const body = !role.data.condition ? `actor.Has(Role${name})` : condition ? `actor.Has(Role${name}) && (${condition})` : 'false';
        blocks.push(`// Is${name} reports whether the actor is ${role.qn}: it carries the role${role.data.condition ? ' and the role\'s condition holds' : ''}.\nfunc Is${name}(actor Actor) bool {\n\treturn ${body}\n}`);
    }
    blocks.push(
        '// Value returns what an optional actor field points to, or the zero value when the actor does not have it.\nfunc Value[T any](p *T) T {\n\tif p == nil {\n\t\tvar zero T\n\t\treturn zero\n\t}\n\treturn *p\n}',
        '// Same reports whether a record ID of the actor refers to the record with the given ID.\nfunc Same(ref *int64, id int64) bool {\n\treturn ref != nil && *ref == id\n}',
        '// SameRef reports whether two record IDs of the actor refer to the same record.\nfunc SameRef(a, b *int64) bool {\n\treturn a != nil && b != nil && *a == *b\n}'
    );
    if (tenant) blocks.push(
        `// Tenanted is a record that belongs to a ${tenantEntity}, the entity of the tenant ${tenant.qn}.\ntype Tenanted interface {\n\t// TenantID returns the ID of the ${tenantEntity}, and false when the record does not reach one.\n\tTenantID() (int64, bool)\n}`,
        '// InTenant reports whether the record belongs to the tenant the actor acts in. An actor without a tenant acts across tenants.\nfunc InTenant(actor Actor, record Tenanted) bool {\n\tif actor.Tenant == nil {\n\t\treturn true\n\t}\n\tid, ok := record.TenantID()\n\treturn ok && id == *actor.Tenant\n}'
    );
    const all = [...imports].sort((a, b) => Number(a.includes('.')) - Number(b.includes('.')) || a.localeCompare(b));
    return `// Package ${access.pkg} holds the actors, roles and tenant of the model and the checks its policies call.\npackage ${access.pkg}\n\nimport (\n${all.map(i => `\t"${i}"`).join('\n')}\n)\n\n${blocks.join('\n\n')}\n`;
}

function roleCondition(role: GraphNode, context: MapContext, access: GoAccess, imports: Set<string>): string | undefined {
    const scope: GoScope = { node: context.node, pkg: access.pkg, imports, importOf: () => access.path, actor: 'actor', access };
    return goExpr(role.data.condition as ExprData, scope);
}

/** The last name of a role or actor, or its module path and name when another role or actor has the same last name. */
function uniqueName(qn: string, context: MapContext): string {
    const node = context.node(qn)!;
    const clash = context.graph.nodes.some(n => n.kind === node.kind && n.qn !== qn && last(n.qn) === last(qn));
    return clash ? qn.split('.').map(pascal).join('') : pascal(last(qn));
}

function parentOf(qn: string): string {
    return qn.slice(0, qn.lastIndexOf('.'));
}

function last(qn: string): string {
    return qn.slice(qn.lastIndexOf('.') + 1);
}

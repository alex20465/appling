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
    const fields = actorFields(context).flatMap(field => {
        const type = actorFieldType(field, context, imports);
        return type ? [{ name: pascal(last(field.qn)), field: last(field.qn), owner: parentOf(field.qn), record: (field.data.type as TypeData).decl, type }] : [];
    });
    return context.render('access/access.go.njk', {
        pkg: access.pkg,
        tenant: tenant && { entity: tenant.data.entity, qn: tenant.qn },
        fields,
        actors: actors.map(a => ({ name: access.name(a.qn), qn: a.qn, kind: a.data.kind, roles: ((a.data.roles ?? []) as string[]).map(r => `Role${access.name(r)}`) })),
        roles: roles.map(r => ({ name: access.name(r.qn), qn: r.qn, conditional: !!r.data.condition, condition: r.data.condition ? roleCondition(r, context, access, imports) : undefined })),
        imports: [...imports].sort((a, b) => Number(a.includes('.')) - Number(b.includes('.')) || a.localeCompare(b))
    }) + '\n';
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

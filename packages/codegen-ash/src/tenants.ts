import type { MapContext, Step } from '@appling/codegen';
import type { GraphNode, TypeData } from '@appling/model';
import { homeAt, homeFields, homes } from './actors.js';
import { lastOf } from './elixir.js';
import { fieldsOf, fileOf, patch, relationTarget, task } from './naming.js';
import { addToSection } from './resource.js';

/**
 * A tenant becomes Ash attribute multitenancy: every resource with a relationship to the tenant's entity is
 * partitioned by that relationship's id, so `tenant: id` scopes every query and change and `^tenant()` reads it.
 * Actor resources stay readable without a tenant (`global? true`), so an actor can be looked up before its tenant
 * is known. Resources that reach the tenant only through other relationships are a task.
 */
export function tenantSteps(tenant: GraphNode, context: MapContext): Step[] {
    const entity = tenant.data.entity as string;
    const tenantEntities = new Set(context.graph.nodes.filter(n => n.kind === 'Tenant').map(n => n.data.entity as string));
    const steps: Step[] = [];
    const partitioned = new Set<string>();
    const ambiguous: string[] = [];
    for (const resource of resources(context)) {
        if (resource.qn === entity) continue;
        const fields = storedRelations(resource, context);
        const own = fields.filter(f => relationTarget(f, context)!.qn === entity);
        if (!own.length) continue;
        if (own.length > 1 || fields.some(f => relationTarget(f, context)!.qn !== entity && tenantEntities.has(relationTarget(f, context)!.qn))) {
            ambiguous.push(resource.qn);
            continue;
        }
        partitioned.add(resource.qn);
        const global = homeAt(resource, context) ? ['global? true'] : [];
        steps.push(patch(fileOf(resource, context), existing => addToSection(existing, 'multitenancy', ['strategy :attribute', `attribute :${lastOf(own[0].qn)}_id`, ...global])));
    }
    const indirect = reaching(new Set([...partitioned, ...ambiguous]), entity, context);
    if (ambiguous.length) steps.push(task(`pick the tenant attribute of ${ambiguous.map(lastOf).join(', ')} for ${lastOf(tenant.qn)}`));
    if (indirect.length) steps.push(task(`partition ${indirect.map(lastOf).join(', ')} by ${lastOf(tenant.qn)}, which they reach only through relationships, for example with a tenant attribute set from the relationship`));
    return steps;
}

/**
 * The relationship that partitions a resource by a tenant, as `tenantSteps` writes it, or undefined when the
 * resource is not partitioned. Actor resources are partitioned too, but stay readable without a tenant.
 */
export function partitionOf(resource: GraphNode, context: MapContext): string | undefined {
    const tenants = context.graph.nodes.filter(n => n.kind === 'Tenant').map(n => n.data.entity as string);
    const fields = storedRelations(resource, context);
    for (const entity of tenants) {
        const own = fields.filter(f => relationTarget(f, context)!.qn === entity);
        if (resource.qn === entity || !own.length) continue;
        if (own.length > 1 || fields.some(f => relationTarget(f, context)!.qn !== entity && tenants.includes(relationTarget(f, context)!.qn))) continue;
        return lastOf(own[0].qn);
    }
    return undefined;
}

/** Every resource: the entities and the human actors without `is`. */
function resources(context: MapContext): GraphNode[] {
    return [
        ...context.graph.nodes.filter(n => n.kind === 'Entity'),
        ...homes(context).filter(h => h.resource && h.node.kind === 'Actor').map(h => h.node)
    ];
}

/** The stored single valued relationships of a resource, including the fields of actors bound to it. */
function storedRelations(resource: GraphNode, context: MapContext): GraphNode[] {
    const home = homeAt(resource, context);
    const fields = home?.resource ? homeFields(home, context) : fieldsOf(resource, context);
    return fields.filter(f => !f.data.derived && !(f.data.type as TypeData).many && relationTarget(f, context));
}

/** The resources outside `partitioned` whose relationships lead to a partitioned one, directly or through others. */
function reaching(partitioned: Set<string>, entity: string, context: MapContext): string[] {
    const reached = new Set(partitioned);
    const found: string[] = [];
    let grew = true;
    while (grew) {
        grew = false;
        for (const resource of resources(context)) {
            if (reached.has(resource.qn) || resource.qn === entity) continue;
            if (storedRelations(resource, context).some(f => reached.has(relationTarget(f, context)!.qn))) {
                reached.add(resource.qn);
                found.push(resource.qn);
                grew = true;
            }
        }
    }
    return found;
}

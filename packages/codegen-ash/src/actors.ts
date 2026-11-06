import type { MapContext, Step } from '@appling/codegen';
import type { ExprData, GraphNode, TypeData } from '@appling/model';
import { constant, lastOf, parentOf } from './elixir.js';
import { attributeType, calculation, fieldsOf, fileOf, mix, moduleName, patch, relationTarget, snake, task, typeModule } from './naming.js';

/**
 * Where an actor lives in the generated project. An actor bound with `is` is a record of its entity's resource; a
 * human actor without `is` gets a resource of its own; a system or service actor without `is` is a plain struct
 * whose `roles` are the roles it declares.
 */
export interface ActorHome {
    /** The entity, or the actor itself for an actor without `is`. */
    node: GraphNode;
    module: string;
    /** Whether the home is an Ash resource (with a stored `roles` attribute), not a struct. */
    resource: boolean;
    /** The actors living in this home. */
    actors: GraphNode[];
}

export function homeOf(actor: GraphNode, context: MapContext): ActorHome {
    const entity = actor.data.entity ? context.node(actor.data.entity as string) : undefined;
    const node = entity ?? actor;
    return {
        node, module: typeModule(node, context), resource: !!entity || actor.data.kind === 'human',
        actors: entity ? context.graph.nodes.filter(n => n.kind === 'Actor' && n.data.entity === entity.qn) : [actor]
    };
}

/** Every home, once each. */
export function homes(context: MapContext): ActorHome[] {
    const seen = new Map<string, ActorHome>();
    for (const actor of context.graph.nodes.filter(n => n.kind === 'Actor')) {
        const home = homeOf(actor, context);
        if (!seen.has(home.node.qn)) seen.set(home.node.qn, home);
    }
    return [...seen.values()];
}

/** The home whose node is this entity or actor, if actors live there. */
export function homeAt(node: GraphNode, context: MapContext): ActorHome | undefined {
    return homes(context).find(h => h.node.qn === node.qn);
}

/** The roles the actors of a home carry, as qualified names in declaration order. */
export function rolesOf(home: ActorHome): string[] {
    return [...new Set(home.actors.flatMap(a => (a.data.roles ?? []) as string[]))];
}

/** The fields an actor's record holds: the entity's fields plus the fields of every actor bound to it. */
export function homeFields(home: ActorHome, context: MapContext): GraphNode[] {
    const own = home.node.kind === 'Entity' ? fieldsOf(home.node, context) : [];
    return [...own, ...home.actors.flatMap(a => fieldsOf(a, context))];
}

/** The `--attribute` specs of the fields of the bound actors and the private `roles` of an entity that actors are bound to. */
export function actorAttributeSpecs(entity: GraphNode, context: MapContext): string[] {
    const home = homeAt(entity, context);
    if (!home) return [];
    return [...home.actors.flatMap(a => attributeSpecs(fieldsOf(a, context), context)), 'roles:atom:array'];
}

export function attributeSpecs(fields: GraphNode[], context: MapContext): string[] {
    return fields.filter(f => !f.data.derived && !relationTarget(f, context)).map(f => {
        const type = f.data.type as TypeData;
        return [lastOf(f.qn), attributeType(type, context), ...(type.many ? ['array'] : []), ...(type.optional ? [] : ['required']), 'public'].join(':');
    });
}

/** Limits the stored `roles` of an actor resource to the roles its actors carry, empty by default. */
export function constrainRoles(text: string, home: ActorHome): string {
    const roles = rolesOf(home).map(r => `:${snake(lastOf(r))}`).join(', ');
    return text.replace(/(\n([ \t]*)attribute :roles, [^\n]* do\n)/, `$1$2  default []\n$2  constraints items: [one_of: [${roles}]]\n`);
}

/**
 * An actor without `is`: a human one becomes a resource of its own with its fields and the private `roles`, a
 * system or service one a struct. An actor bound with `is` lives in its entity's resource, which already has
 * its fields and roles.
 */
export function actorSteps(actor: GraphNode, context: MapContext, patchResource: (text: string, node: GraphNode, context: MapContext) => string): Step[] {
    const home = homeOf(actor, context);
    if (home.node.kind === 'Entity') return [];
    const fields = fieldsOf(actor, context);
    if (!home.resource) return [{ kind: 'template', file: fileOf(actor, context), write: () => struct(actor, home, context) }];
    const specs = [...attributeSpecs(fields, context), 'roles:atom:array'];
    return [
        mix(['ash.gen.resource', home.module, '--domain', moduleName(actor.module, context),
            '--default-actions', 'read,create,update,destroy', '--uuid-primary-key', 'id', '--attribute', specs.join(','),
            '--extend', 'postgres', '--timestamps']),
        patch(fileOf(actor, context), existing => patchResource(existing, actor, context))
    ];
}

/** A field of an actor: a column or relationship of the actor's resource, or a key of its struct. */
export function actorFieldSteps(field: GraphNode, context: MapContext): Step[] {
    const home = homeOf(context.node(parentOf(field.qn))!, context);
    const type = field.data.type as TypeData;
    const target = relationTarget(field, context);
    if (!home.resource) return field.data.derived ? [task(`compute ${lastOf(field.qn)} = ${field.props.derived} in ${home.module}`)] : [];
    if (target && type.many) return [task(`model the many to many relationship ${lastOf(field.qn)} to ${target.qn}`)];
    if (target) {
        const spec = ['belongs_to', lastOf(field.qn), typeModule(target, context), ...(type.optional ? [] : ['required'])].join(':');
        return [{ ...mix(['ash.gen.resource', home.module, '--relationship', spec]), phase: 1 }];
    }
    const tasks: Step[] = [];
    if (field.data.derived && !calculation(field, context)) tasks.push(task(`add the calculation ${lastOf(field.qn)} = ${field.props.derived} to ${home.module}`));
    if (field.data.default && !field.data.derived && constant(field.data.default as ExprData, context.node) === undefined) tasks.push(task(`set the default of ${lastOf(field.qn)} to ${field.props.default}`));
    return tasks;
}

function struct(actor: GraphNode, home: ActorHome, context: MapContext): string {
    const keys = fieldsOf(actor, context).filter(f => !f.data.derived).map(f => {
        const value = f.data.default ? constant(f.data.default as ExprData, context.node) : undefined;
        return `${lastOf(f.qn)}${relationTarget(f, context) ? '_id' : ''}: ${value ?? 'nil'}`;
    });
    const roles = rolesOf(home).map(r => `:${snake(lastOf(r))}`).join(', ');
    return [
        `defmodule ${home.module} do`,
        `  @moduledoc ${JSON.stringify(`The ${actor.data.kind} actor ${lastOf(actor.qn)}. Pass %${home.module}{} as the actor.`)}`,
        `  defstruct [${[...keys, `roles: [${roles}]`].join(', ')}]`,
        'end',
        ''
    ].join('\n');
}

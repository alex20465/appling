import type { MapContext, Step } from '@appling/codegen';
import type { ExprData, GraphNode, TypeData } from '@appling/model';
import { ashExpr, lastOf } from './elixir.js';
import { attributeType, children, fileOf, patch, snake, task, TYPES } from './naming.js';
import { addToSection } from './resource.js';

/** A query becomes a read action of its entity's resource with its inputs as arguments, filter, sort and pagination. */
export function querySteps(query: GraphNode, context: MapContext): Step[] {
    const entity = context.node(query.data.entity as string)!;
    const translated = query.data.filter ? ashExpr(query.data.filter as ExprData, context.node) : undefined;
    // A filter that does not translate reads nothing until it is written, so routes and pages can name the action.
    const filter = query.data.filter && !translated ? 'false' : translated;
    const tasks = query.data.filter && !translated ? [task(`filter the read action ${snake(lastOf(query.qn))} by ${query.props.filter}; it reads nothing until then`)] : [];
    const sorts = ((query.data.sorts ?? []) as { field: string, direction?: string }[]).map(s => `${lastOf(s.field)}: :${s.direction ?? 'asc'}`);
    const lines = [
        `read :${snake(lastOf(query.qn))} do`,
        ...children(query, context, 'Param').map(input => `  argument :${lastOf(input.qn)}, ${argumentType(input.data.type as TypeData, context)}, allow_nil?: ${(input.data.type as TypeData).optional ? 'true' : 'false'}`),
        ...(filter ? [`  filter expr(${filter})`] : []),
        ...(sorts.length ? [`  prepare build(sort: [${sorts.join(', ')}])`] : []),
        ...(query.data.pageSize ? [`  pagination offset?: true, default_limit: ${query.data.pageSize}, required?: false`] : []),
        'end'
    ];
    return [patch(fileOf(entity, context), existing => addToSection(existing, 'actions', lines)), ...tasks];
}

/** The Ash type of a read action argument; an input that names a record of an entity takes its id. */
function argumentType(type: TypeData, context: MapContext): string {
    const base = type.decl && context.node(type.decl)?.kind === 'Entity' ? ':uuid' : attributeType(type, context, true);
    return type.many ? `{:array, ${base}}` : base;
}

/** Computed projection fields become calculations on the source resource; plain fields are its attributes already. */
export function projectionFieldSteps(field: GraphNode, context: MapContext): Step[] {
    const value = field.data.value as ExprData | undefined;
    if (!value) return [];
    const projection = context.node(field.qn.slice(0, field.qn.lastIndexOf('.')))!;
    const source = context.node(projection.data.source as string)!;
    const entity = source.kind === 'Query' ? context.node(source.data.entity as string)! : source;
    const body = ashExpr(value, context.node);
    const type = TYPES[value.type.replace(/\?$/, '')];
    if (!body || !type) return [task(`add the calculation ${lastOf(field.qn)} = ${field.props.value} to ${lastOf(entity.qn)}`)];
    return [patch(fileOf(entity, context), existing => addToSection(existing, 'calculations', [`calculate :${lastOf(field.qn)}, :${type}, expr(${body})`]))];
}

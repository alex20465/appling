import type { MapContext, Step } from '@appling/codegen';
import type { ExprData, GraphNode } from '@appling/model';
import { ashExpr, lastOf } from './elixir.js';
import { fileOf, patch, snake, task, TYPES } from './naming.js';
import { addToSection } from './resource.js';

/** A query becomes a read action of its entity's resource with filter, sort and pagination. */
export function querySteps(query: GraphNode, context: MapContext): Step[] {
    const entity = context.node(query.data.entity as string)!;
    const filter = query.data.filter ? ashExpr(query.data.filter as ExprData, context.node) : undefined;
    if (query.data.filter && !filter) return [task(`filter the read action ${snake(lastOf(query.qn))} by ${query.props.filter}`)];
    const sorts = ((query.data.sorts ?? []) as { field: string, direction?: string }[]).map(s => `${lastOf(s.field)}: :${s.direction ?? 'asc'}`);
    const lines = [
        `read :${snake(lastOf(query.qn))} do`,
        ...(filter ? [`  filter expr(${filter})`] : []),
        ...(sorts.length ? [`  prepare build(sort: [${sorts.join(', ')}])`] : []),
        ...(query.data.pageSize ? [`  pagination offset?: true, default_limit: ${query.data.pageSize}, required?: false`] : []),
        'end'
    ];
    return [patch(fileOf(entity, context), existing => addToSection(existing, 'actions', lines))];
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

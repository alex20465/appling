import type { CommandStep, MapContext, Step } from '@appling/codegen';
import type { ExprData, GraphNode, TypeData } from '@appling/model';
import { ashExpr, lastOf } from './elixir.js';

export const TYPES: Record<string, string> = {
    String: 'string', Text: 'string', Int: 'integer', Decimal: 'decimal', Money: 'decimal', Bool: 'boolean',
    Date: 'date', DateTime: 'utc_datetime_usec', Duration: 'duration', File: 'string', Uuid: 'uuid'
};

export function attributeType(type: TypeData, context: MapContext, asCode = false): string {
    if (type.primitive) return asCode ? `:${TYPES[type.primitive]}` : TYPES[type.primitive];
    return typeModule(context.node(type.decl!)!, context);
}

export function relationTarget(field: GraphNode, context: MapContext): GraphNode | undefined {
    const decl = (field.data.type as TypeData | undefined)?.decl;
    const target = decl ? context.node(decl) : undefined;
    return target?.kind === 'Entity' ? target : undefined;
}

export function fieldsOf(node: GraphNode, context: MapContext): GraphNode[] {
    return context.children(node.qn).filter(f => f.kind === 'Field');
}

export function app(context: MapContext): string {
    return context.name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
}

export function moduleName(moduleQn: string, context: MapContext): string {
    return [app(context), ...moduleQn.split('.')].map(pascal).join('.');
}

export function typeModule(node: GraphNode, context: MapContext): string {
    return `${moduleName(node.module, context)}.${lastOf(node.qn)}`;
}

export function fileOf(node: GraphNode, context: MapContext): string {
    return ['lib', app(context), ...node.module.split('.').map(snake), `${snake(lastOf(node.qn))}.ex`].join('/');
}

export function pascal(name: string): string {
    return name.split('_').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('');
}

export function snake(name: string): string {
    return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

export function mix(args: string[]): CommandStep {
    return { kind: 'command', run: ['mix', ...args, '--yes'] };
}

export function task(what: string): Step {
    return { kind: 'task', what };
}

export function children(node: GraphNode, context: MapContext, kind?: string): GraphNode[] {
    return context.children(node.qn).filter(c => !kind || c.kind === kind);
}

/** The attributes of a resource that are stored columns, not calculations or relationships. */
export function storedAttributes(entity: GraphNode, context: MapContext): Set<string> {
    return new Set(fieldsOf(entity, context).filter(f => !f.data.derived && !relationTarget(f, context)).map(f => f.qn));
}

/** Patches a generated module after every resource and relationship exists, so expressions may follow relationships. */
export function patch(file: string, write: (existing: string) => string): Step {
    return { kind: 'template', file, write: existing => write(existing!), phase: 2 };
}

/** The calculation for a derived field, or undefined when Ash expressions cannot say it. */
export function calculation(field: GraphNode, context: MapContext): string | undefined {
    const type = field.data.type as TypeData;
    const body = field.data.derived && !type.many && ashExpr(field.data.derived as ExprData, context.node);
    return body ? `calculate :${lastOf(field.qn)}, ${attributeType(type, context, true)}, expr(${body})` : undefined;
}

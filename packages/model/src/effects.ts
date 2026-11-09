import type { ExprData } from './graph.js';

/**
 * The value of a `set` inside `update <path> { … }` as an expression of the action: every name that stands for a
 * field of the updated entity reads that field through the path, so `stock - item.quantity` inside
 * `update item.product` becomes `item.product.stock - item.quantity`. `entity` is the qualified name in the
 * effect's `data.entity`, `path` its `data.target`.
 */
export function throughPath(expr: ExprData, entity: string, path: ExprData): ExprData {
    if (expr.$type === 'NameExpr' && !expr.call && expr.target === `${entity}.${expr.name}`) {
        return { $type: 'MemberExpr', receiver: path, member: expr.name, target: expr.target, type: expr.type };
    }
    const result: ExprData = { ...expr };
    for (const key of ['left', 'right', 'operand', 'receiver', 'index'] as const) {
        if (expr[key]) result[key] = throughPath(expr[key], entity, path);
    }
    for (const key of ['args', 'items'] as const) {
        if (expr[key]) result[key] = expr[key].map(e => throughPath(e, entity, path));
    }
    return result;
}

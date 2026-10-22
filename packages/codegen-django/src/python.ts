import type { ExprData, GraphNode } from '@appling/model';

export interface PythonScope {
    node(qn: string): GraphNode | undefined;
    /** The instance expression, such as `self`; undefined at class level. */
    self?: string;
    vars?: Set<string>;
    imports: Set<string>;
}

const OPERATORS: Record<string, string> = { '&&': 'and', '||': 'or' };
const LOOKUPS: Record<string, string> = { '==': '', '<': '__lt', '<=': '__lte', '>': '__gt', '>=': '__gte' };
const FLIPPED: Record<string, string> = { '<': '>', '<=': '>=', '>': '<', '>=': '<=', '==': '==', '!=': '!=' };
const DURATION_UNITS: Record<string, string> = { d: 'days', h: 'hours', m: 'minutes', s: 'seconds', ms: 'milliseconds' };

/** Translates an expression to Python, or returns undefined when it uses something without a Python counterpart, such as `actor`. */
export function python(expr: ExprData, scope: PythonScope): string | undefined {
    const sub = (e: ExprData) => python(e, scope);
    switch (expr.$type) {
        case 'StringExpr': return JSON.stringify(expr.value);
        case 'NumberExpr': return String(expr.value);
        case 'BoolExpr': return expr.value ? 'True' : 'False';
        case 'NullExpr': return 'None';
        case 'ListExpr': return joined((expr.items ?? []).map(sub), items => `[${items.join(', ')}]`);
        case 'UnaryExpr': {
            const operand = sub(expr.operand!);
            return operand && (expr.op === '!' ? `not ${wrap(operand)}` : `-${wrap(operand)}`);
        }
        case 'BinaryExpr': {
            const [left, right] = [sub(expr.left!), sub(expr.right!)];
            return left && right && `${wrap(left)} ${OPERATORS[expr.op!] ?? expr.op} ${wrap(right)}`;
        }
        case 'IndexExpr': {
            const [receiver, index] = [sub(expr.receiver!), sub(expr.index!)];
            return receiver && index && `${receiver}[${index}]`;
        }
        case 'NameExpr': return expr.call ? call(expr, scope) : name(expr, scope);
        case 'MemberExpr': return expr.call ? method(expr, scope) : member(expr, scope);
    }
}

/** Translates a condition over stored fields of one model to a `models.Q`, or undefined. */
export function q(expr: ExprData, stored: Set<string>, node: (qn: string) => GraphNode | undefined): string | undefined {
    const literal = (e: ExprData) => literalOf(e, node);
    const field = (e: ExprData | undefined) => e?.$type === 'NameExpr' && !e.call && e.target && stored.has(e.target) ? e.name : undefined;
    if (expr.$type === 'BinaryExpr' && (expr.op === '&&' || expr.op === '||')) {
        const [left, right] = [q(expr.left!, stored, node), q(expr.right!, stored, node)];
        return left && right && `(${left}) ${expr.op === '&&' ? '&' : '|'} (${right})`;
    }
    if (expr.$type === 'UnaryExpr' && expr.op === '!') {
        const operand = q(expr.operand!, stored, node);
        return operand && `~(${operand})`;
    }
    if (expr.$type === 'NameExpr' && expr.call && expr.name === 'has' && field(expr.args?.[0])) return `models.Q(${field(expr.args![0])}__isnull=False)`;
    if (expr.$type !== 'BinaryExpr') return undefined;
    if (expr.op === 'in') {
        const values = expr.right?.$type === 'ListExpr' ? joined(expr.right.items!.map(literal), v => v.join(', ')) : undefined;
        return field(expr.left) && values !== undefined ? `models.Q(${field(expr.left)}__in=[${values}])` : undefined;
    }
    const [name, other, op] = field(expr.left) ? [field(expr.left)!, expr.right!, expr.op!] : field(expr.right) ? [field(expr.right)!, expr.left!, FLIPPED[expr.op!]] : [];
    if (!name || !op || !other) return undefined;
    const value = field(other) ? `models.F(${JSON.stringify(field(other))})` : literal(other);
    if (value === undefined) return undefined;
    if (value === 'None' && (op === '==' || op === '!=')) return `models.Q(${name}__isnull=${op === '==' ? 'True' : 'False'})`;
    if (op === '!=') return `~models.Q(${name}=${value})`;
    return op in LOOKUPS ? `models.Q(${name}${LOOKUPS[op]}=${value})` : undefined;
}

/** A constant for a database lookup; enum values are stored as their name. */
function literalOf(expr: ExprData, node: (qn: string) => GraphNode | undefined): string | undefined {
    if (expr.$type === 'NameExpr' && !expr.call && expr.target && node(expr.target)?.kind === 'EnumLiteral') return JSON.stringify(expr.name);
    return ['StringExpr', 'NumberExpr', 'BoolExpr', 'NullExpr'].includes(expr.$type) ? python(expr, { node: () => undefined, imports: new Set() }) : undefined;
}

function name(expr: ExprData, scope: PythonScope): string | undefined {
    const id = expr.name!;
    if (scope.vars?.has(id)) return id;
    if (id === 'this' && !expr.target) return scope.self;
    if (id === 'now' && !expr.target) {
        scope.imports.add('from django.utils import timezone');
        return 'timezone.now()';
    }
    const target = expr.target ? scope.node(expr.target) : undefined;
    if (target?.kind === 'Field' && scope.node(parentOf(target.qn))?.kind === 'Entity') return scope.self && `${scope.self}.${id}`;
    if (target?.kind === 'EnumLiteral') {
        const enumQn = parentOf(target.qn);
        const enumNode = scope.node(enumQn)!;
        scope.imports.add(`from ${appOf(enumNode.module)}.enums import ${lastOf(enumQn)}`);
        return `${lastOf(enumQn)}.${constantOf(id)}`;
    }
    return undefined;
}

function member(expr: ExprData, scope: PythonScope): string | undefined {
    const receiver = python(expr.receiver!, scope);
    const target = expr.target ? scope.node(expr.target) : undefined;
    if (!receiver || target?.kind !== 'Field') return undefined;
    const owner = scope.node(parentOf(target.qn))?.kind;
    if (owner === 'ValueType') return `${receiver}[${JSON.stringify(expr.member)}]`;
    return owner === 'Entity' ? `${receiver}.${expr.member}` : undefined;
}

function call(expr: ExprData, scope: PythonScope): string | undefined {
    const [arg] = expr.args ?? [];
    if (expr.name === 'duration') return arg?.$type === 'StringExpr' ? duration(String(arg.value), scope) : undefined;
    const value = arg && python(arg, scope);
    if (!value) return undefined;
    switch (expr.name) {
        case 'sum':
        case 'min':
        case 'max': return `${expr.name}(${value})`;
        case 'size': return `len(${value})`;
        case 'has': return `${wrap(value)} is not None`;
    }
    return undefined;
}

function method(expr: ExprData, scope: PythonScope): string | undefined {
    const receiver = python(expr.receiver!, scope);
    if (!receiver) return undefined;
    const args = expr.args ?? [];
    if (['map', 'filter', 'exists', 'all'].includes(expr.member!)) {
        const variable = args[0].name!;
        const body = python(args[1], { ...scope, vars: new Set([...(scope.vars ?? []), variable]) });
        if (!body) return undefined;
        switch (expr.member) {
            case 'map': return `[${body} for ${variable} in ${receiver}]`;
            case 'filter': return `[${variable} for ${variable} in ${receiver} if ${body}]`;
            case 'exists': return `any(${body} for ${variable} in ${receiver})`;
            default: return `all(${body} for ${variable} in ${receiver})`;
        }
    }
    if (expr.member === 'size') return `len(${receiver})`;
    const arg = args[0] && python(args[0], scope);
    if (!arg) return undefined;
    switch (expr.member) {
        case 'contains': return `${wrap(arg)} in ${wrap(receiver)}`;
        case 'startsWith': return `${receiver}.startswith(${arg})`;
        case 'endsWith': return `${receiver}.endswith(${arg})`;
        case 'matches':
            scope.imports.add('import re');
            return `re.search(${arg}, ${receiver}) is not None`;
    }
    return undefined;
}

/** `720h`, `1h30m`, `2d` in the style of Go and CEL durations. */
function duration(text: string, scope: PythonScope): string | undefined {
    const parts = [...text.matchAll(/(\d+(?:\.\d+)?)(ms|d|h|m|s)/g)];
    if (!parts.length || parts.map(p => p[0]).join('') !== text) return undefined;
    scope.imports.add('from datetime import timedelta');
    return `timedelta(${parts.map(([, amount, unit]) => `${DURATION_UNITS[unit]}=${amount}`).join(', ')})`;
}

function wrap(code: string): string {
    return /^[\w.]+(\(.*\)|\[.*\])?$/.test(code) || /^".*"$/.test(code) ? code : `(${code})`;
}

function joined(parts: (string | undefined)[], combine: (parts: string[]) => string): string | undefined {
    return parts.every(p => p !== undefined) ? combine(parts as string[]) : undefined;
}

export function parentOf(qn: string): string {
    return qn.slice(0, qn.lastIndexOf('.'));
}

export function lastOf(qn: string): string {
    return qn.slice(qn.lastIndexOf('.') + 1);
}

export function appOf(module: string): string {
    return module.replaceAll('.', '_');
}

export function constantOf(name: string): string {
    return name.toUpperCase();
}

import type { ExprData, GraphNode } from '@appling/model';

type Lookup = (qn: string) => GraphNode | undefined;

const OPERATORS: Record<string, string> = { '&&': 'and', '||': 'or' };
const COMPARE: Record<string, string> = { '<': 'less_than', '<=': 'less_than_or_equal_to', '>': 'greater_than', '>=': 'greater_than_or_equal_to' };
const FLIPPED: Record<string, string> = { '<': '>', '<=': '>=', '>': '<', '>=': '<=', '==': '==', '!=': '!=' };

/** Translates an expression to the body of an Ash `expr(...)`, or returns undefined when Ash expressions cannot say it. */
export function ashExpr(expr: ExprData, node: Lookup): string | undefined {
    const sub = (e: ExprData) => ashExpr(e, node);
    switch (expr.$type) {
        case 'StringExpr':
        case 'NumberExpr':
        case 'BoolExpr':
        case 'NullExpr': return constant(expr, node);
        case 'ListExpr': return joined((expr.items ?? []).map(sub), items => `[${items.join(', ')}]`);
        case 'UnaryExpr': {
            const operand = sub(expr.operand!);
            return operand && (expr.op === '!' ? `not ${wrap(operand)}` : `-${wrap(operand)}`);
        }
        case 'BinaryExpr': {
            const shift = relativeTime(expr);
            if (shift) return shift;
            const [left, right] = [sub(expr.left!), sub(expr.right!)];
            return left && right && `${wrap(left)} ${OPERATORS[expr.op!] ?? expr.op} ${wrap(right)}`;
        }
        case 'NameExpr': {
            if (expr.call) {
                const arg = expr.name === 'has' && expr.args?.[0] && sub(expr.args[0]);
                return arg ? `not is_nil(${arg})` : undefined;
            }
            if (expr.name === 'now' && !expr.target) return 'now()';
            const target = expr.target ? node(expr.target) : undefined;
            if (target?.kind === 'EnumLiteral') return `:${expr.name}`;
            if (target?.kind === 'Param') return `^arg(:${expr.name})`;
            return target?.kind === 'Field' && node(parentOf(target.qn))?.kind === 'Entity' ? expr.name : undefined;
        }
        case 'MemberExpr': {
            const receiver = !expr.call && sub(expr.receiver!);
            const target = expr.target ? node(expr.target) : undefined;
            return receiver && target?.kind === 'Field' && node(parentOf(target.qn))?.kind === 'Entity' ? `${receiver}.${expr.member}` : undefined;
        }
        default: return undefined;
    }
}

/** Translates a condition over stored attributes to an Ash builtin validation, or undefined. */
export function validation(expr: ExprData, stored: Set<string>, node: Lookup): string | undefined {
    const field = (e: ExprData | undefined) => e?.$type === 'NameExpr' && !e.call && e.target && stored.has(e.target) ? e.name : undefined;
    const sub = (e: ExprData) => validation(e, stored, node);
    if (expr.$type === 'BinaryExpr' && (expr.op === '&&' || expr.op === '||')) {
        const [left, right] = [sub(expr.left!), sub(expr.right!)];
        return left && right && `${expr.op === '&&' ? 'all' : 'any'}([${left}, ${right}])`;
    }
    if (expr.$type === 'UnaryExpr' && expr.op === '!') {
        const operand = sub(expr.operand!);
        return operand && `negate(${operand})`;
    }
    if (expr.$type === 'NameExpr' && expr.call && expr.name === 'has' && field(expr.args?.[0])) return `present(:${field(expr.args![0])})`;
    if (expr.$type !== 'BinaryExpr') return undefined;
    if (expr.op === 'in') {
        const values = expr.right?.$type === 'ListExpr' ? joined(expr.right.items!.map(i => constant(i, node)), v => v.join(', ')) : undefined;
        return field(expr.left) && values !== undefined ? `attribute_in(:${field(expr.left)}, [${values}])` : undefined;
    }
    const [name, other, op] = field(expr.left) ? [field(expr.left)!, expr.right, expr.op!] : field(expr.right) ? [field(expr.right)!, expr.left, FLIPPED[expr.op!]] : [];
    if (!name || !other || !op) return undefined;
    const otherField = field(other);
    const value = otherField ? `:${otherField}` : constant(other, node);
    if (value === undefined) return undefined;
    if (op in COMPARE) return `compare(:${name}, ${COMPARE[op]}: ${value})`;
    if (otherField) return undefined;
    if (value === 'nil') return op === '==' ? `absent(:${name})` : `present(:${name})`;
    return op === '==' ? `attribute_equals(:${name}, ${value})` : op === '!=' ? `attribute_does_not_equal(:${name}, ${value})` : undefined;
}

/** A literal or enum value as an Elixir constant. */
export function constant(expr: ExprData, node: Lookup): string | undefined {
    switch (expr.$type) {
        case 'StringExpr': return JSON.stringify(expr.value);
        case 'NumberExpr': return String(expr.value);
        case 'BoolExpr': return String(expr.value);
        case 'NullExpr': return 'nil';
        case 'NameExpr': return !expr.call && expr.target && node(expr.target)?.kind === 'EnumLiteral' ? `:${expr.name}` : undefined;
        default: return undefined;
    }
}

const UNITS: Record<string, string> = { d: 'day', h: 'hour', m: 'minute', s: 'second' };

/** `now - duration("720h")` and `now + duration(...)` as Ash's `ago(720, :hour)` and `from_now(...)`. */
function relativeTime(expr: ExprData): string | undefined {
    const [left, right] = [expr.left!, expr.right!];
    const isNow = left.$type === 'NameExpr' && left.name === 'now' && !left.target && !left.call;
    const arg = right.$type === 'NameExpr' && right.call && right.name === 'duration' ? right.args?.[0] : undefined;
    const match = arg?.$type === 'StringExpr' ? /^(\d+)(d|h|m|s)$/.exec(String(arg.value)) : null;
    if (!isNow || !match || (expr.op !== '-' && expr.op !== '+')) return undefined;
    return `${expr.op === '-' ? 'ago' : 'from_now'}(${match[1]}, :${UNITS[match[2]]})`;
}

function wrap(code: string): string {
    return /^[\w.:]+(\(.*\))?$/.test(code) || /^".*"$/.test(code) || /^\[.*\]$/.test(code) ? code : `(${code})`;
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

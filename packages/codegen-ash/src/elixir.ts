import { durationMs, type ExprData, type GraphNode } from '@appling/model';

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
            if (expr.op === '==' || expr.op === '!=') {
                // A query input compared with null, as an optional input's filter writes it: `since == null`.
                const input = [expr.left!, expr.right!].find(e => isInput(e, node));
                if (input && [expr.left!, expr.right!].some(e => e.$type === 'NullExpr')) return `${expr.op === '!=' ? 'not ' : ''}is_nil(^arg(:${input.name}))`;
                const references = [referenceId(expr.left!, node), referenceId(expr.right!, node)];
                if (references.some(r => r && r !== 'nil') && references.every(Boolean)) return `${references[0]} ${expr.op} ${references[1]}`;
            }
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
            if (target?.kind === 'Tenant') return '^tenant()';
            return target && isRecordField(target, node) ? expr.name : undefined;
        }
        case 'MemberExpr': {
            const target = expr.target ? node(expr.target) : undefined;
            if (isActor(expr.receiver) && !expr.call) return target && isRecordField(target, node) ? `^actor(:${expr.member})` : undefined;
            const receiver = !expr.call && sub(expr.receiver!);
            return receiver && target?.kind === 'Field' && node(parentOf(target.qn))?.kind === 'Entity' ? `${receiver}.${expr.member}` : undefined;
        }
        default: return undefined;
    }
}

/** Whether an expression is the bare name `actor`. */
export function isActor(expr: ExprData | undefined): boolean {
    return expr?.$type === 'NameExpr' && expr.name === 'actor' && !expr.target && !expr.call;
}

/** A field of an entity or of an actor, which the actor's resource or struct holds. */
function isRecordField(target: GraphNode, node: Lookup): boolean {
    const owner = node(parentOf(target.qn))?.kind;
    return target.kind === 'Field' && (owner === 'Entity' || owner === 'Actor');
}

/**
 * A side of a comparison between records as the id Ash compares: `customer` becomes `customer_id`, `buyer.company`
 * `buyer.company_id`, `actor.account` `^actor(:account_id)`, `actor` `^actor(:id)`, `this` `id`, `tenant` `^tenant()`
 * and `null` `nil`. Undefined for anything that is not a record.
 */
function referenceId(expr: ExprData, node: Lookup): string | undefined {
    if (expr.$type === 'NullExpr') return 'nil';
    if (isActor(expr)) return '^actor(:id)';
    if (expr.$type === 'NameExpr' && !expr.call) {
        if (expr.name === 'this' && !expr.target) return 'id';
        const target = expr.target ? node(expr.target) : undefined;
        if (target?.kind === 'Tenant') return '^tenant()';
        // An input that names a record, such as `of: Customer` of a query, is the record's id.
        if (target?.kind === 'Param' && isRecordType(target, node)) return `^arg(:${expr.name})`;
        return target && isRelation(target, node) ? `${expr.name}_id` : undefined;
    }
    if (expr.$type === 'MemberExpr' && !expr.call) {
        const target = expr.target ? node(expr.target) : undefined;
        if (!target || !isRelation(target, node)) return undefined;
        if (isActor(expr.receiver)) return `^actor(:${expr.member}_id)`;
        const receiver = ashExpr(expr.receiver!, node);
        return receiver && `${receiver}.${expr.member}_id`;
    }
    return undefined;
}

/** A single valued field whose type is an entity, a `belongs_to` relationship. */
function isRelation(target: GraphNode, node: Lookup): boolean {
    return isRecordField(target, node) && isRecordType(target, node);
}

/** A field or input that holds one record of an entity. */
function isRecordType(target: GraphNode, node: Lookup): boolean {
    const type = target.data.type as { decl?: string, many?: boolean } | undefined;
    return !!type?.decl && !type.many && node(type.decl)?.kind === 'Entity';
}

/** The bare name of an input, such as a query input. */
function isInput(expr: ExprData, node: Lookup): expr is ExprData & { name: string } {
    return expr.$type === 'NameExpr' && !expr.call && !!expr.target && node(expr.target)?.kind === 'Param';
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

const AGO_UNITS: [string, number][] = [['day', 86_400_000], ['hour', 3_600_000], ['minute', 60_000], ['second', 1000], ['millisecond', 1]];

/** A duration such as `48h` or `1h30m` as Ash's `ago(90, :minute)`, in the largest unit that divides it. */
export function ago(text: string): string | undefined {
    const ms = durationMs(text);
    const unit = AGO_UNITS.find(([, size]) => ms > 0 && ms % size === 0);
    return unit && `ago(${ms / unit[1]}, :${unit[0]})`;
}

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
    const call = /^\^?[\w.:]+(\(.*\))?$/.exec(code);
    // `is_nil(a) or (b)` looks like one call to the pattern; the call's parenthesis has to close at the end.
    return (call && (!call[1] || closesAtEnd(call[1]))) || /^".*"$/.test(code) || /^\[.*\]$/.test(code) ? code : `(${code})`;
}

/** Whether the parenthesis that opens the text closes only at its end. */
function closesAtEnd(text: string): boolean {
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '(') depth++;
        else if (text[i] === ')' && --depth === 0) return i === text.length - 1;
    }
    return false;
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

/** An Elixir string literal, without interpolation. */
export function elixirString(text: string): string {
    return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/#\{/g, '\\#{').replace(/\n/g, '\\n')}"`;
}

/** The `@moduledoc` lines of a node's `does` text, a heredoc when it spans lines; none without a text. */
export function moduledoc(node: GraphNode): string {
    const text = node.data.does;
    if (typeof text !== 'string' || !text.trim()) return '';
    if (!text.includes('\n')) return `  @moduledoc ${elixirString(text)}\n\n`;
    const body = text.replace(/\\/g, '\\\\').replace(/#\{/g, '\\#{').replace(/"""/g, '\\"""').split('\n').map(l => l ? `  ${l}` : '').join('\n');
    return `  @moduledoc """\n${body}\n  """\n\n`;
}

/** Puts the node's `@moduledoc` first in the module. */
export function withModuledoc(text: string, node: GraphNode): string {
    const doc = moduledoc(node);
    return doc ? text.replace(/^(defmodule [^\n]* do\n)/, head => head + doc) : text;
}

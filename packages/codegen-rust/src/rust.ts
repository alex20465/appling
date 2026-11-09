import type { ExprData, GraphNode } from '@appling/model';

export type Kind = 'decimal' | 'time' | 'duration' | 'int' | 'string' | 'bool' | 'list' | 'null' | 'other' | 'id';

interface Rust {
    code: string;
    kind: Kind;
    /** The code is an `Option` (an optional field), so reading the value needs `.unwrap()`. */
    option?: boolean;
    /** How to read the value when it is not `code.unwrap()`, such as `actor.active.clone().unwrap_or_default()`. */
    read?: string;
}

/** The generated access module: the actor, role and tenant checks that policies and role conditions call. */
export interface RustAccess {
    /** The module name, such as `access`. */
    module: string;
    /** The Rust name of a role or actor, such as `Clerk`, prefixed with its module when the last name is not unique. */
    name(qn: string): string;
}

export interface RustScope {
    node(qn: string): GraphNode | undefined;
    /** The variable holding the record: `self` in methods, the entity's name in actions. */
    self?: string;
    /** The Rust module the code is written in, to qualify names from other modules. */
    module: string;
    vars?: Map<string, Kind>;
    /** The variable holding the current `&Actor`, in policies and role conditions; without it `actor` and `tenant` do not translate. */
    actor?: string;
    access?: RustAccess;
}

const UNITS: { [unit: string]: string } = { ms: 'milliseconds', s: 'seconds', m: 'minutes', h: 'hours', d: 'days' };

/** Translates an expression to Rust, or returns undefined when Rust code cannot say it, such as `actor` outside a policy. */
export function rustExpr(expr: ExprData, scope: RustScope): string | undefined {
    const result = translate(expr, scope);
    return result && value(result);
}

/**
 * Translates an expression for an assignment: `value` reads it (`x.unwrap()` for an `Option`), `raw` is the code as
 * it is (the `Option` itself for an optional field or input), `null` marks the literal `null` and `empty` the empty list `[]`.
 */
export function rustTerm(expr: ExprData, scope: RustScope): { value: string, raw: string, option: boolean, null: boolean, empty?: boolean } | undefined {
    if (expr.$type === 'ListExpr' && !expr.items?.length) return { value: '', raw: '', option: false, null: false, empty: true };
    const result = translate(expr, scope);
    return result && { value: value(result), raw: result.code, option: !!result.option, null: result.kind === 'null' };
}

export function kindOf(type: string): Kind {
    const base = type.replace(/\?$/, '');
    if (base.endsWith('[]')) return 'list';
    return ({ Money: 'decimal', Decimal: 'decimal', DateTime: 'time', Date: 'time', Duration: 'duration', Int: 'int', String: 'string', Text: 'string', Bool: 'bool', null: 'null' } as { [t: string]: Kind })[base] ?? 'other';
}

function translate(expr: ExprData, scope: RustScope): Rust | undefined {
    switch (expr.$type) {
        case 'StringExpr': return { code: JSON.stringify(expr.value), kind: 'string' };
        case 'NumberExpr': return { code: String(expr.value), kind: String(expr.value).includes('.') ? 'decimal' : 'int' };
        case 'BoolExpr': return { code: String(expr.value), kind: 'bool' };
        case 'NullExpr': return { code: 'None', kind: 'null' };
        case 'UnaryExpr': {
            const operand = translate(expr.operand!, scope);
            return operand && { code: `${expr.op === '!' ? '!' : '-'}${wrap(value(operand))}`, kind: operand.kind };
        }
        case 'BinaryExpr': return binary(expr, scope);
        case 'NameExpr': return expr.call ? call(expr, scope) : name(expr, scope);
        case 'MemberExpr':
            if (isActor(expr.receiver!, scope)) return actorMember(expr, scope);
            return expr.call ? method(expr, scope) : member(expr, scope);
        case 'IndexExpr': {
            const [list, index] = [translate(expr.receiver!, scope), translate(expr.index!, scope)];
            return list && index ? { code: `${value(list)}[${value(index)} as usize]`, kind: kindOf(expr.type) } : undefined;
        }
        default: return undefined;
    }
}

function binary(expr: ExprData, scope: RustScope): Rust | undefined {
    const op = expr.op!;
    if (op === 'in') {
        const left = translate(expr.left!, scope);
        const items = (expr.right?.items ?? []).map(i => translate(i, scope));
        if (!left || expr.right?.$type !== 'ListExpr' || items.some(i => !i)) return undefined;
        return { code: `[${items.map(i => value(i!)).join(', ')}].contains(&${wrap(value(left))})`, kind: 'bool' };
    }
    const [left, right] = [translate(expr.left!, scope), translate(expr.right!, scope)];
    if (!left || !right) return undefined;
    if ((op === '==' || op === '!=') && (left.kind === 'null' || right.kind === 'null')) {
        const subject = left.kind === 'null' ? right : left;
        return { code: `${subject.code}.${op === '==' ? 'is_none' : 'is_some'}()`, kind: 'bool' };
    }
    if (op === '&&' || op === '||') return { code: `${wrap(value(left))} ${op} ${wrap(value(right))}`, kind: 'bool' };
    if (left.kind === 'id' || right.kind === 'id') {
        const same = sameRecord(left, right);
        if (!same || (op !== '==' && op !== '!=')) return undefined;
        return { code: op === '!=' ? `!${wrap(same)}` : same, kind: 'bool' };
    }
    const decimal = left.kind === 'decimal' || right.kind === 'decimal';
    const [a, b] = decimal ? [toDecimal(left), toDecimal(right)] : [value(left), value(right)];
    const comparison = ['==', '!=', '<', '<=', '>', '>='].includes(op);
    const kind: Kind = comparison ? 'bool' : left.kind === 'time' && right.kind === 'time' ? 'duration' : decimal ? 'decimal' : left.kind;
    return { code: `${wrap(a)} ${op} ${wrap(b)}`, kind };
}

function name(expr: ExprData, scope: RustScope): Rust | undefined {
    const id = expr.name!;
    if (scope.vars?.has(id)) return { code: id, kind: scope.vars.get(id)! };
    if (isActor(expr, scope)) return scope.actor ? { code: `${scope.actor}.id`, kind: 'id', option: true } : undefined;
    if (expr.target && scope.node(expr.target)?.kind === 'Tenant') return scope.actor ? { code: `${scope.actor}.tenant`, kind: 'id', option: true } : undefined;
    if (!expr.target) {
        if (id === 'this') return scope.self ? { code: scope.self, kind: 'other' } : undefined;
        if (id === 'now') return { code: 'chrono::Utc::now()', kind: 'time' };
        return undefined;
    }
    const target = scope.node(expr.target);
    if (target?.kind === 'EnumLiteral') return { code: enumVariant(target, scope), kind: 'other' };
    if (target?.kind === 'Param') return { code: id, kind: kindOf(expr.type), option: expr.type.endsWith('?') };
    if (target?.kind === 'Field' && scope.self && isRecordField(target, scope)) {
        return { code: `${scope.self}.${id}${target.data.derived ? '()' : ''}`, kind: kindOf(expr.type), option: optional(target) };
    }
    return undefined;
}

function member(expr: ExprData, scope: RustScope): Rust | undefined {
    const receiver = translate(expr.receiver!, scope);
    const target = expr.target ? scope.node(expr.target) : undefined;
    if (!receiver || receiver.kind === 'id' || target?.kind !== 'Field' || !isRecordField(target, scope)) return undefined;
    return { code: `${value(receiver)}.${expr.member}${target.data.derived ? '()' : ''}`, kind: kindOf(expr.type), option: optional(target) };
}

function call(expr: ExprData, scope: RustScope): Rust | undefined {
    const [arg] = expr.args ?? [];
    if (expr.name === 'duration') {
        const parts = [...String(arg?.value ?? '').matchAll(/(\d+)(ms|d|h|m|s)/g)];
        return parts.length ? { code: parts.map(([, amount, unit]) => `chrono::TimeDelta::${UNITS[unit]}(${amount})`).join(' + '), kind: 'duration' } : undefined;
    }
    const subject = arg && translate(arg, scope);
    if (!subject) return undefined;
    if (expr.name === 'has') return subject.option ? { code: `${subject.code}.is_some()`, kind: 'bool' } : undefined;
    if (expr.name === 'size') return { code: `${value(subject)}.len() as i64`, kind: 'int' };
    if (expr.name === 'sum') {
        const kind = kindOf(expr.type);
        const mapped = arg.$type === 'MemberExpr' && arg.call && arg.member === 'map';
        const iterator = mapped ? value(subject).replace(/\.collect::<Vec<_>>\(\)$/, '') : `${value(subject)}.iter().copied()`;
        return { code: `${iterator}.sum::<${kind === 'decimal' ? 'rust_decimal::Decimal' : 'i64'}>()`, kind };
    }
    return undefined;
}

function method(expr: ExprData, scope: RustScope): Rust | undefined {
    const receiver = translate(expr.receiver!, scope);
    if (!receiver) return undefined;
    const args = expr.args ?? [];
    if (expr.member === 'size') return { code: `${value(receiver)}.len() as i64`, kind: 'int' };
    if (['map', 'filter', 'exists', 'all'].includes(expr.member!)) {
        const [variable, body] = [args[0].name!, args[1]];
        const inner = translate(body, { ...scope, vars: new Map([...(scope.vars ?? []), [variable, 'other' as Kind]]) });
        if (!inner) return undefined;
        const items = `${value(receiver)}.iter()`;
        switch (expr.member) {
            case 'map': return { code: `${items}.map(|${variable}| ${value(inner)}).collect::<Vec<_>>()`, kind: 'list' };
            case 'filter': return { code: `${items}.filter(|${variable}| ${value(inner)}).cloned().collect::<Vec<_>>()`, kind: 'list' };
            case 'exists': return { code: `${items}.any(|${variable}| ${value(inner)})`, kind: 'bool' };
            default: return { code: `${items}.all(|${variable}| ${value(inner)})`, kind: 'bool' };
        }
    }
    const arg = args[0] && translate(args[0], scope);
    if (!arg) return undefined;
    const text: { [member: string]: string } = { contains: 'contains', startsWith: 'starts_with', endsWith: 'ends_with' };
    return expr.member! in text ? { code: `${value(receiver)}.${text[expr.member!]}(&*${wrap(value(arg))})`, kind: 'bool' } : undefined;
}

function toDecimal(rust: Rust): string {
    if (rust.kind === 'decimal' && !/^[\d.]+$/.test(rust.code)) return value(rust);
    if (/^\d+$/.test(rust.code)) return `rust_decimal::Decimal::from(${rust.code})`;
    if (/^[\d.]+$/.test(rust.code)) return `rust_decimal::Decimal::from_str_exact(${JSON.stringify(rust.code)}).unwrap()`;
    return `rust_decimal::Decimal::from(${value(rust)})`;
}

function value(rust: Rust): string {
    return rust.read ?? (rust.option ? `${rust.code}.unwrap()` : rust.code);
}

/** The name `actor` itself, not a closure variable or a field that happens to be called so. */
function isActor(expr: ExprData, scope: RustScope): boolean {
    return expr.$type === 'NameExpr' && expr.name === 'actor' && !expr.target && !expr.call && !scope.vars?.has('actor');
}

/**
 * `actor.is(X)` calls the role check `is_x` or compares the actor type; `actor.field` reads the field of the
 * `Actor`, an `Option` that is `None` for actors without it. Fields that hold records hold their id.
 */
function actorMember(expr: ExprData, scope: RustScope): Rust | undefined {
    const { actor, access } = scope;
    if (!actor || !access) return undefined;
    if (expr.call) {
        const target = expr.member === 'is' && expr.args?.[0]?.target ? scope.node(expr.args[0].target) : undefined;
        if (target?.kind === 'Role') return { code: `${accessPath(`is_${snake(access.name(target.qn))}`, scope)}(${actor})`, kind: 'bool' };
        if (target?.kind === 'Actor') return { code: `${actor}.actor_type == ${accessPath(`ActorType::${access.name(target.qn)}`, scope)}`, kind: 'bool' };
        return undefined;
    }
    const target = expr.target ? scope.node(expr.target) : undefined;
    const type = target?.kind === 'Field' ? target.data.type as { primitive?: string, decl?: string, many?: boolean } : undefined;
    if (!type) return undefined;
    const code = `${actor}.${expr.member}`;
    if (type.many) return { code, kind: 'list' };
    if (type.decl) return scope.node(type.decl)?.kind === 'Entity' ? { code, kind: 'id', option: true } : undefined;
    return { code, kind: kindOf(type.primitive!), option: true, read: `${code}.clone().unwrap_or_default()` };
}

/** Whether a record id of the actor (or the tenant) refers to a record: `actor.account == Some(order.customer.id)`. */
function sameRecord(left: Rust, right: Rust): string | undefined {
    if (left.kind === 'id' && right.kind === 'id') return `(${left.code}.is_some() && ${left.code} == ${right.code})`;
    const [id, record] = left.kind === 'id' ? [left, right] : [right, left];
    if (record.kind !== 'other') return undefined;
    return record.option ? `(${id.code}.is_some() && ${id.code} == ${record.code}.as_ref().map(|r| r.id))` : `${id.code} == Some(${record.code}.id)`;
}

/** A path into the access module, qualified outside it. */
function accessPath(name: string, scope: RustScope): string {
    return scope.access!.module === scope.module ? name : `crate::${scope.access!.module}::${name}`;
}

function wrap(code: string): string {
    return atomic(code) ? code : `(${code})`;
}

/**
 * Whether the code needs no parentheses as an operand: paths, calls and fields (`a::b(x).c`), one bracketed
 * group or a string. Brackets are matched, so `f(a) && g(b)` is not atomic.
 */
function atomic(code: string): boolean {
    if (/^"([^"\\]|\\.)*"$/.test(code)) return true;
    let depth = 0;
    for (let i = 0; i < code.length; i++) {
        const c = code[i];
        if (c === '"') {
            for (i++; i < code.length && code[i] !== '"'; i++) if (code[i] === '\\') i++;
        } else if ('([{'.includes(c)) depth++;
        else if (')]}'.includes(c)) depth--;
        else if (depth === 0 && !/[\w.:]/.test(c)) return false;
    }
    return depth === 0;
}

function isRecordField(field: GraphNode, scope: RustScope): boolean {
    const owner = scope.node(field.qn.slice(0, field.qn.lastIndexOf('.')))?.kind;
    return owner === 'Entity' || owner === 'ValueType' || owner === 'Event';
}

function optional(field: GraphNode): boolean {
    const type = field.data.type as { optional?: boolean, many?: boolean } | undefined;
    return !!type?.optional && !type.many;
}

/** The Rust path of an enum value, such as `OrderStatus::Draft`, qualified outside its module. */
export function enumVariant(literal: GraphNode, scope: RustScope): string {
    const enumNode = scope.node(literal.qn.slice(0, literal.qn.lastIndexOf('.')))!;
    return `${qualify(enumNode, scope)}::${pascal(literal.qn.slice(literal.qn.lastIndexOf('.') + 1))}`;
}

export function qualify(declaration: GraphNode, scope: RustScope): string {
    const name = declaration.qn.slice(declaration.qn.lastIndexOf('.') + 1);
    return declaration.module === scope.module ? name : `crate::${declaration.module.replaceAll('.', '::')}::${name}`;
}

export function pascal(name: string): string {
    return name.split('_').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('');
}

export function snake(name: string): string {
    return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

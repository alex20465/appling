import type { ExprData, GraphNode } from '@appling/model';

/** What a translated expression is in Go, which decides the operators: decimals and times have methods. */
type Kind = 'decimal' | 'time' | 'duration' | 'int' | 'string' | 'bool' | 'list' | 'null' | 'other' | 'id';

interface Go {
    code: string;
    kind: Kind;
    /** The code is a pointer to the value (an optional field), so reading it needs `*`. */
    pointer?: boolean;
    /** How to read the value when it is not `*code`, such as `access.Value(actor.Active)`. */
    read?: string;
}

/** The generated access package: the actor, role and tenant checks that policies and role conditions call. */
export interface GoAccess {
    /** The package name, such as `access`. */
    pkg: string;
    /** The import path, such as `shop/internal/access`. */
    path: string;
    /** The Go name of a role or actor, such as `Clerk`, prefixed with its module when the last name is not unique. */
    name(qn: string): string;
}

export interface GoScope {
    node(qn: string): GraphNode | undefined;
    /** The variable holding the record, such as `o` in a method or `order` in an action. */
    self?: string;
    /** The Go package the code is written in, to qualify names from other modules. */
    pkg: string;
    vars?: Map<string, Kind>;
    /** The Go variable of a name in `vars` when it differs from the name, such as `typeRow` for `type`. */
    rename?: Map<string, string>;
    imports: Set<string>;
    /** The Go import path of a module, such as `shop/internal/crm`. */
    importOf(module: string): string;
    /** The variable holding the current `access.Actor`, in policies and role conditions; without it `actor` and `tenant` do not translate. */
    actor?: string;
    access?: GoAccess;
}

const COMPARE: { [op: string]: string } = { '<': 'LessThan', '<=': 'LessThanOrEqual', '>': 'GreaterThan', '>=': 'GreaterThanOrEqual' };
const ARITHMETIC: { [op: string]: string } = { '+': 'Add', '-': 'Sub', '*': 'Mul', '/': 'Div' };
const UNITS: { [unit: string]: string } = { ms: 'time.Millisecond', s: 'time.Second', m: 'time.Minute', h: 'time.Hour', d: '24 * time.Hour' };

/** Translates an expression to Go, or returns undefined when Go code cannot say it, such as `actor` outside a policy. */
export function goExpr(expr: ExprData, scope: GoScope): string | undefined {
    const result = translate(expr, scope);
    return result && value(result);
}

/**
 * Translates an expression for an assignment: `value` reads it (`*p` for a pointer), `raw` is the code as it is
 * (the pointer itself for an optional field or input), `null` marks the literal `null` and `empty` the empty list `[]`.
 */
export function goTerm(expr: ExprData, scope: GoScope): { value: string, raw: string, pointer: boolean, null: boolean, empty?: boolean } | undefined {
    if (expr.$type === 'ListExpr' && !expr.items?.length) return { value: '', raw: '', pointer: false, null: false, empty: true };
    const result = translate(expr, scope);
    return result && { value: value(result), raw: result.code, pointer: !!result.pointer, null: result.kind === 'null' };
}

/** The Go type of a primitive and the package it needs. */
export const PRIMITIVES: { [name: string]: [string, string?] } = {
    String: ['string'], Text: ['string'], Int: ['int64'], Bool: ['bool'], File: ['string'], Uuid: ['string'],
    Decimal: ['decimal.Decimal', 'github.com/shopspring/decimal'], Money: ['decimal.Decimal', 'github.com/shopspring/decimal'],
    Date: ['time.Time', 'time'], DateTime: ['time.Time', 'time'], Duration: ['time.Duration', 'time']
};

/** The Go type of an Appling type name as the typer shows it, such as `Money`, `Line[]` or `DateTime?`. */
export function kindOf(type: string): Kind {
    const base = type.replace(/\?$/, '');
    if (base.endsWith('[]')) return 'list';
    return ({ Money: 'decimal', Decimal: 'decimal', DateTime: 'time', Date: 'time', Duration: 'duration', Int: 'int', String: 'string', Text: 'string', Bool: 'bool', null: 'null' } as { [t: string]: Kind })[base] ?? 'other';
}

function translate(expr: ExprData, scope: GoScope): Go | undefined {
    switch (expr.$type) {
        case 'StringExpr': return { code: JSON.stringify(expr.value), kind: 'string' };
        case 'NumberExpr': return { code: String(expr.value), kind: String(expr.value).includes('.') ? 'decimal' : 'int' };
        case 'BoolExpr': return { code: String(expr.value), kind: 'bool' };
        case 'NullExpr': return { code: 'nil', kind: 'null' };
        case 'UnaryExpr': {
            const operand = translate(expr.operand!, scope);
            if (!operand) return undefined;
            if (expr.op === '!') return { code: `!${wrap(value(operand))}`, kind: 'bool' };
            return operand.kind === 'decimal' ? { code: `${wrap(value(operand))}.Neg()`, kind: 'decimal' } : { code: `-${wrap(value(operand))}`, kind: operand.kind };
        }
        case 'BinaryExpr': return binary(expr, scope);
        case 'NameExpr': return expr.call ? call(expr, scope) : name(expr, scope);
        case 'MemberExpr':
            if (isActor(expr.receiver!, scope)) return actorMember(expr, scope);
            return expr.call ? method(expr, scope) : member(expr, scope);
        case 'IndexExpr': {
            const [list, index] = [translate(expr.receiver!, scope), translate(expr.index!, scope)];
            return list && index ? { code: `${value(list)}[${value(index)}]`, kind: kindOf(expr.type) } : undefined;
        }
        default: return undefined;
    }
}

function binary(expr: ExprData, scope: GoScope): Go | undefined {
    const op = expr.op!;
    if (op === 'in') {
        const left = translate(expr.left!, scope);
        const items = (expr.right?.items ?? []).map(i => translate(i, scope));
        if (!left || expr.right?.$type !== 'ListExpr' || items.some(i => !i)) return undefined;
        scope.imports.add('slices');
        return { code: `slices.Contains([]${elementType(left, expr.right.items!, scope)}{${items.map(i => value(i!)).join(', ')}}, ${value(left)})`, kind: 'bool' };
    }
    const [left, right] = [translate(expr.left!, scope), translate(expr.right!, scope)];
    if (!left || !right) return undefined;
    if (op === '&&' || op === '||') return { code: `${wrap(value(left))} ${op} ${wrap(value(right))}`, kind: 'bool' };
    if ((op === '==' || op === '!=') && (left.kind === 'null' || right.kind === 'null')) {
        const subject = left.kind === 'null' ? right : left;
        return { code: `${subject.code} ${op} nil`, kind: 'bool' };
    }
    if (left.kind === 'id' || right.kind === 'id') {
        const same = sameRecord(left, right, scope);
        if (!same || (op !== '==' && op !== '!=')) return undefined;
        return { code: op === '!=' ? `!${wrap(same)}` : same, kind: 'bool' };
    }
    const kinds = [left.kind, right.kind];
    if (kinds.includes('decimal')) {
        const [a, b] = [decimal(left, scope), decimal(right, scope)];
        if (op === '==' || op === '!=') return { code: `${op === '!=' ? '!' : ''}${a}.Equal(${b})`, kind: 'bool' };
        if (op in COMPARE) return { code: `${a}.${COMPARE[op]}(${b})`, kind: 'bool' };
        if (op in ARITHMETIC) return { code: `${a}.${ARITHMETIC[op]}(${b})`, kind: 'decimal' };
        return undefined;
    }
    if (left.kind === 'time') {
        const [a, b] = [value(left), value(right)];
        if (right.kind === 'duration' && (op === '+' || op === '-')) return { code: `${a}.Add(${op === '-' ? `-${wrap(b)}` : b})`, kind: 'time' };
        if (right.kind === 'time' && op === '-') return { code: `${a}.Sub(${b})`, kind: 'duration' };
        const compare: { [op: string]: string } = { '<': `${a}.Before(${b})`, '>': `${a}.After(${b})`, '<=': `!${a}.After(${b})`, '>=': `!${a}.Before(${b})`, '==': `${a}.Equal(${b})`, '!=': `!${a}.Equal(${b})` };
        return op in compare ? { code: compare[op], kind: 'bool' } : undefined;
    }
    const comparison = ['==', '!=', '<', '<=', '>', '>='].includes(op);
    return { code: `${wrap(value(left))} ${op} ${wrap(value(right))}`, kind: comparison ? 'bool' : left.kind };
}

function name(expr: ExprData, scope: GoScope): Go | undefined {
    const id = expr.name!;
    if (scope.vars?.has(id)) return { code: scope.rename?.get(id) ?? id, kind: scope.vars.get(id)! };
    if (isActor(expr, scope)) return scope.actor ? { code: `${scope.actor}.ID`, kind: 'id', pointer: true } : undefined;
    if (expr.target && scope.node(expr.target)?.kind === 'Tenant') return scope.actor ? { code: `${scope.actor}.Tenant`, kind: 'id', pointer: true } : undefined;
    if (!expr.target) {
        if (id === 'this') return scope.self ? { code: scope.self, kind: 'other' } : undefined;
        if (id === 'now') {
            scope.imports.add('time');
            return { code: 'time.Now()', kind: 'time' };
        }
        return undefined;
    }
    const target = scope.node(expr.target);
    if (target?.kind === 'EnumLiteral') return { code: enumConstant(target, scope), kind: 'other' };
    if (target?.kind === 'Param') return { code: camel(id), kind: kindOf(expr.type), pointer: expr.type.endsWith('?') };
    if (target?.kind === 'Field' && scope.self && isRecordField(target, scope)) {
        return { code: `${scope.self}.${pascal(id)}${target.data.derived ? '()' : ''}`, kind: kindOf(expr.type), pointer: optional(target) };
    }
    return undefined;
}

function member(expr: ExprData, scope: GoScope): Go | undefined {
    const receiver = translate(expr.receiver!, scope);
    const target = expr.target ? scope.node(expr.target) : undefined;
    if (!receiver || receiver.kind === 'id' || target?.kind !== 'Field' || !isRecordField(target, scope)) return undefined;
    return { code: `${value(receiver)}.${pascal(expr.member!)}${target.data.derived ? '()' : ''}`, kind: kindOf(expr.type), pointer: optional(target) };
}

function call(expr: ExprData, scope: GoScope): Go | undefined {
    const [arg] = expr.args ?? [];
    if (expr.name === 'duration') {
        const parts = [...String(arg?.value ?? '').matchAll(/(\d+)(ms|d|h|m|s)/g)];
        if (!parts.length) return undefined;
        scope.imports.add('time');
        return { code: parts.map(([, amount, unit]) => `${amount} * ${UNITS[unit]}`).join(' + '), kind: 'duration' };
    }
    if (expr.name === 'has') {
        const subject = arg && translate(arg, scope);
        return subject?.pointer ? { code: `${subject.code} != nil`, kind: 'bool' } : undefined;
    }
    if (expr.name === 'size') {
        const subject = arg && translate(arg, scope);
        return subject && { code: `int64(len(${value(subject)}))`, kind: 'int' };
    }
    if (expr.name === 'sum' && arg) return sum(arg, kindOf(expr.type), scope);
    return undefined;
}

function method(expr: ExprData, scope: GoScope): Go | undefined {
    const receiver = translate(expr.receiver!, scope);
    if (!receiver) return undefined;
    const args = expr.args ?? [];
    if (expr.member === 'size') return { code: `int64(len(${value(receiver)}))`, kind: 'int' };
    if (expr.member === 'exists' || expr.member === 'all') {
        const [variable, body] = [args[0].name!, args[1]];
        const test = translate(body, { ...scope, vars: new Map([...(scope.vars ?? []), [variable, 'other' as Kind]]) });
        if (!test) return undefined;
        const [hit, miss] = expr.member === 'exists' ? ['true', 'false'] : ['false', 'true'];
        const condition = expr.member === 'exists' ? value(test) : `!${wrap(value(test))}`;
        return { code: `func() bool { for _, ${variable} := range ${value(receiver)} { if ${condition} { return ${hit} } }; return ${miss} }()`, kind: 'bool' };
    }
    const arg = args[0] && translate(args[0], scope);
    if (!arg) return undefined;
    const text: { [member: string]: [string, string] } = { contains: ['strings', 'strings.Contains'], startsWith: ['strings', 'strings.HasPrefix'], endsWith: ['strings', 'strings.HasSuffix'] };
    if (expr.member! in text) {
        scope.imports.add(text[expr.member!][0]);
        return { code: `${text[expr.member!][1]}(${value(receiver)}, ${value(arg)})`, kind: 'bool' };
    }
    if (expr.member === 'matches') {
        scope.imports.add('regexp');
        return { code: `regexp.MustCompile(${value(arg)}).MatchString(${value(receiver)})`, kind: 'bool' };
    }
    return undefined;
}

/** `sum(list)` and `sum(list.map(x, body))` as a loop. */
function sum(arg: ExprData, kind: Kind, scope: GoScope): Go | undefined {
    const mapped = arg.$type === 'MemberExpr' && arg.call && arg.member === 'map' ? arg : undefined;
    const list = translate(mapped ? mapped.receiver! : arg, scope);
    const variable = mapped ? mapped.args![0].name! : 'item';
    const item = mapped ? translate(mapped.args![1], { ...scope, vars: new Map([...(scope.vars ?? []), [variable, 'other' as Kind]]) }) : { code: variable, kind };
    if (!list || !item) return undefined;
    if (kind === 'decimal') {
        scope.imports.add('github.com/shopspring/decimal');
        return { code: `func() decimal.Decimal { total := decimal.Zero; for _, ${variable} := range ${value(list)} { total = total.Add(${value(item)}) }; return total }()`, kind };
    }
    return { code: `func() int64 { var total int64; for _, ${variable} := range ${value(list)} { total += ${value(item)} }; return total }()`, kind: 'int' };
}

function decimal(go: Go, scope: GoScope): string {
    scope.imports.add('github.com/shopspring/decimal');
    if (go.kind === 'decimal') return wrap(value(go));
    return /^\d+$/.test(go.code) ? `decimal.NewFromInt(${go.code})` : /^[\d.]+$/.test(go.code) ? `decimal.RequireFromString(${JSON.stringify(go.code)})` : `decimal.NewFromInt(${value(go)})`;
}

function value(go: Go): string {
    return go.read ?? (go.pointer ? `(*${go.code})` : go.code);
}

/** The name `actor` itself, not a lambda variable or a field that happens to be called so. */
function isActor(expr: ExprData, scope: GoScope): boolean {
    return expr.$type === 'NameExpr' && expr.name === 'actor' && !expr.target && !expr.call && !scope.vars?.has('actor');
}

/**
 * `actor.is(X)` calls the role check `IsX` or compares the actor type; `actor.field` reads the field of the
 * `access.Actor`, a pointer that is nil for actors without it. Fields that hold records hold their ID.
 */
function actorMember(expr: ExprData, scope: GoScope): Go | undefined {
    const { actor, access } = scope;
    if (!actor || !access) return undefined;
    if (expr.call) {
        const target = expr.member === 'is' && expr.args?.[0]?.target ? scope.node(expr.args[0].target) : undefined;
        if (target?.kind === 'Role') return { code: `${accessName(`Is${access.name(target.qn)}`, scope)}(${actor})`, kind: 'bool' };
        if (target?.kind === 'Actor') return { code: `${actor}.Type == ${accessName(`Actor${access.name(target.qn)}`, scope)}`, kind: 'bool' };
        return undefined;
    }
    const target = expr.target ? scope.node(expr.target) : undefined;
    const type = target?.kind === 'Field' ? target.data.type as { primitive?: string, decl?: string, many?: boolean } : undefined;
    if (!type) return undefined;
    const code = `${actor}.${pascal(expr.member!)}`;
    if (type.many) return { code, kind: 'list' };
    if (type.decl) return scope.node(type.decl)?.kind === 'Entity' ? { code, kind: 'id', pointer: true } : undefined;
    return { code, kind: kindOf(type.primitive!), pointer: true, read: `${accessName('Value', scope)}(${code})` };
}

/** Whether a record ID of the actor (or the tenant) refers to a record: `access.Same(actor.Account, order.Customer.ID)`. */
function sameRecord(left: Go, right: Go, scope: GoScope): string | undefined {
    if (left.kind === 'id' && right.kind === 'id') return `${accessName('SameRef', scope)}(${left.code}, ${right.code})`;
    const [id, record] = left.kind === 'id' ? [left, right] : [right, left];
    if (record.kind !== 'other') return undefined;
    const same = `${accessName('Same', scope)}(${id.code}, ${record.code}.ID)`;
    return record.pointer ? `(${record.code} != nil && ${same})` : same;
}

/** A name from the access package, qualified outside it. */
function accessName(name: string, scope: GoScope): string {
    const access = scope.access!;
    if (access.pkg === scope.pkg) return name;
    scope.imports.add(access.path);
    return `${access.pkg}.${name}`;
}

function wrap(code: string): string {
    return atomic(code) ? code : `(${code})`;
}

/**
 * Whether the code needs no parentheses as an operand: names, calls and selectors (`a.B(x).C`), one
 * parenthesized group or a string. Brackets are matched, so `f(a) && g(b)` is not atomic.
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
        else if (depth === 0 && !/[\w.]/.test(c)) return false;
    }
    return depth === 0;
}

function isRecordField(field: GraphNode, scope: GoScope): boolean {
    const owner = scope.node(field.qn.slice(0, field.qn.lastIndexOf('.')))?.kind;
    return owner === 'Entity' || owner === 'ValueType' || owner === 'Event';
}

function optional(field: GraphNode): boolean {
    const type = field.data.type as { optional?: boolean, many?: boolean, decl?: string } | undefined;
    return !!type?.optional && !type.many;
}

/** The Go constant of an enum value, qualified with its package outside its module. */
export function enumConstant(literal: GraphNode, scope: GoScope): string {
    const enumQn = literal.qn.slice(0, literal.qn.lastIndexOf('.'));
    const enumNode = scope.node(enumQn)!;
    return `${qualify(enumNode, scope)}${pascal(literal.qn.slice(literal.qn.lastIndexOf('.') + 1))}`;
}

/** The Go name of a declaration, with its package prefix when it lives in another module. */
export function qualify(declaration: GraphNode, scope: GoScope): string {
    const name = declaration.qn.slice(declaration.qn.lastIndexOf('.') + 1);
    const pkg = declaration.module.split('.').pop()!;
    if (pkg === scope.pkg) return name;
    scope.imports.add(scope.importOf(declaration.module));
    return `${pkg}.${name}`;
}

/** The element type of a list literal: the enum of its values, or the Go type of the compared value. */
function elementType(left: Go, items: ExprData[], scope: GoScope): string {
    const literal = items[0]?.target ? scope.node(items[0].target) : undefined;
    if (literal?.kind === 'EnumLiteral') return qualify(scope.node(literal.qn.slice(0, literal.qn.lastIndexOf('.')))!, scope);
    return ({ string: 'string', int: 'int64', bool: 'bool' } as { [k: string]: string })[left.kind] ?? 'any';
}

export function pascal(name: string): string {
    return name.split('_').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('').replace(/^Id$/, 'ID');
}

export function camel(name: string): string {
    const p = pascal(name);
    return p.charAt(0).toLowerCase() + p.slice(1);
}

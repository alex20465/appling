import { AstUtils, WorkspaceCache, type AstNode } from 'langium';
import {
    isAction, isActor, isAssignment, isBinaryExpr, isBoolExpr, isCall, isCreateEffect, isEntity, isEnum, isExpr, isExternalOperation,
    isField, isIndexExpr, isInvariant, isJob, isListExpr, isMemberExpr, isNameExpr, isNullExpr, isNumberExpr, isPolicy,
    isPrecondition, isProjectionField, isQuery, isRole, isSetEffect, isStringExpr, isTenant, isTransition, isUnaryExpr, isUseCase,
    isDeleteEffect, isEffect, isForEffect, isUpdateEffect,
    type Action, type Actor, type Assignment, type BinaryExpr, type Call, type Entity, type Enum, type Event, type Expr,
    type Field, type MemberExpr, type NameExpr, type Param, type Policy, type Query, type Tenant, type Transition, type TypeRef, type UpdateEffect, type ValueType
} from './generated/ast.js';
import { projectionSourceEntity, type ApplingScopeProvider } from './appling-scope.js';
import type { ApplingServices } from './appling-module.js';

export type Type = (
    | { kind: 'primitive'; name: string }
    | { kind: 'decl'; decl: Entity | ValueType | Enum }
    | { kind: 'list'; item: Type }
    | { kind: 'actor' }
    /** `actor.f` when actors declare `f` with different types: any of them. */
    | { kind: 'union'; types: Type[] }
    | { kind: 'null' }
    | { kind: 'error' }
) & { optional?: boolean };

export interface Problem {
    node: AstNode;
    message: string;
    property?: string;
}

interface Binding {
    type: Type;
    target?: AstNode;
}

type Env = Map<string, Binding>;

interface Context {
    env: Env;
    expected?: Type;
    condition?: boolean;
}

interface Signature {
    params: Type[];
    required: number;
}

const ERROR: Type = { kind: 'error' };
const NULL: Type = { kind: 'null' };
const ACTOR: Type = { kind: 'actor' };
const NUMERIC = ['Int', 'Decimal', 'Money'];
const TEMPORAL = ['Date', 'DateTime'];
const TEXT = ['String', 'Text'];
const ORDERED = [...NUMERIC, ...TEMPORAL, 'Duration', ...TEXT];
const MACROS = ['map', 'filter', 'exists', 'all'];
const FUNCTIONS = ['duration', 'sum', 'min', 'max', 'size', 'has'];
const STRING_METHODS = ['contains', 'startsWith', 'endsWith', 'matches'];

const facts = new WeakMap<ApplingServices, WorkspaceCache<string, { actors: Actor[], tenants: Tenant[] }>>();

/**
 * Types the expressions of a model. Names inside expressions are plain strings in the AST, so the typer
 * also records which element each name stands for (`targets`), for tools that follow or rename them.
 */
export class ExpressionTyper {

    readonly types = new Map<Expr, Type>();
    /** For names, members and effect assignments: the element they stand for. */
    readonly targets = new Map<AstNode, AstNode>();
    /** For members that stand for more than one field (`actor.f` declared by several actors): every one, the first is in `targets`. */
    readonly candidates = new Map<AstNode, AstNode[]>();
    readonly problems: Problem[] = [];
    private readonly actors: Actor[];
    private readonly tenants: Tenant[];

    constructor(private readonly services: ApplingServices) {
        if (!facts.has(services)) facts.set(services, new WorkspaceCache(services.shared));
        const all = facts.get(services)!.get('facts', () => {
            const nodes = services.shared.workspace.LangiumDocuments.all.flatMap(d => AstUtils.streamAst(d.parseResult.value)).toArray();
            return { actors: nodes.filter(isActor), tenants: nodes.filter(isTenant) };
        });
        this.actors = all.actors;
        this.tenants = all.tenants;
    }

    /** Types every expression and call of a model. */
    checkModel(model: AstNode): void {
        for (const node of AstUtils.streamAst(model)) {
            if (isExpr(node) && !isExpr(node.$container)) this.check(node);
            if (isCall(node)) this.checkCall(node);
        }
    }

    /** Types an expression that is not part of a larger expression, against what its position expects. */
    check(root: Expr): void {
        const context = this.contextOf(root);
        if (!context) return;
        const type = this.infer(root, context.env, context.expected);
        if (!context.expected || assignable(type, context.expected)) return;
        this.problem(root, context.condition
            ? `A condition must be Bool, not ${show(type)}.`
            : `${show(type)} is not assignable to ${show(context.expected)}.`);
    }

    /** The type of an expression in its position, such as the record a relationship path in `update` leads to. */
    typeOf(root: Expr): Type | undefined {
        this.check(root);
        return this.types.get(root);
    }

    /** The names an effect sees besides those of later effects: its record's fields, the inputs, the loop variables and earlier `as` names. */
    namesAt(effect: AstNode): string[] {
        return [...this.effectEnv(effect).keys()];
    }

    checkCall(call: Call): void {
        const target = call.target.ref;
        if (!target) return;
        const { params, required } = signature(target);
        if (call.args.length < required || call.args.length > params.length) {
            const range = required === params.length ? `${required}` : `${required} to ${params.length}`;
            this.problem(call, `${target.name} takes ${range} argument(s), got ${call.args.length}.`, 'args');
        }
    }

    private contextOf(root: Expr): Context | undefined {
        const owner = root.$container;
        const condition = { expected: primitive('Bool'), condition: true };
        if (isField(owner)) return { env: this.fieldsEnv(owner.$container), expected: typeOfRef(owner.type) };
        if (isInvariant(owner)) return { env: this.entityEnv(owner.$container), ...condition };
        if (isPolicy(owner)) return { env: this.policyEnv(owner), ...condition };
        if (isRole(owner)) return { env: this.base(), ...condition };
        if (isPrecondition(owner)) return { env: this.actionEnv(owner.$container), ...condition };
        if (isTransition(owner)) return { env: this.entityEnv(machineEntity(owner)), ...condition };
        if (isJob(owner)) return { env: this.actionEnv(owner.action.ref), ...condition };
        if (isQuery(owner)) return { env: this.queryEnv(owner), ...condition };
        if (isProjectionField(owner)) return { env: this.entityEnv(projectionSourceEntity(owner.$container)) };
        if (isSetEffect(owner)) {
            const env = isUpdateEffect(owner.$container) ? this.updateEnv(owner.$container) : this.effectEnv(owner);
            return { env, expected: owner.field.ref && typeOfRef(owner.field.ref.type) };
        }
        if (isAssignment(owner)) return { env: this.effectEnv(owner.$container), expected: this.assignmentTarget(owner) };
        if (isUpdateEffect(owner) || isDeleteEffect(owner)) return { env: this.effectEnv(owner) };
        if (isCall(owner)) {
            const target = owner.target.ref;
            const useCase = AstUtils.getContainerOfType(owner, isUseCase);
            return { env: this.paramsEnv(useCase?.params ?? []), expected: target && signature(target).params[owner.args.indexOf(root)] };
        }
        return undefined;
    }

    private infer(expr: Expr, env: Env, expected?: Type): Type {
        const type = this.inferNode(expr, env, expected);
        this.types.set(expr, type);
        return type;
    }

    private inferNode(expr: Expr, env: Env, expected?: Type): Type {
        if (isStringExpr(expr)) return primitive('String');
        if (isNumberExpr(expr)) return primitive(expr.$cstNode?.text.includes('.') ? 'Decimal' : 'Int');
        if (isBoolExpr(expr)) return primitive('Bool');
        if (isNullExpr(expr)) return NULL;
        if (isListExpr(expr)) {
            const item = expected?.kind === 'list' ? expected.item : undefined;
            const items = expr.items.map(i => this.infer(i, env, item));
            return { kind: 'list', item: items[0] ?? item ?? ERROR };
        }
        if (isUnaryExpr(expr)) {
            const operand = this.infer(expr.operand, env);
            if (operand.kind === 'error') return ERROR;
            if (expr.op === '!' ? is(operand, 'Bool') : is(operand, ...NUMERIC, 'Duration')) return { ...operand, optional: false };
            return this.problem(expr, `Operator "${expr.op}" does not apply to ${show(operand)}.`);
        }
        if (isBinaryExpr(expr)) return this.binary(expr, env);
        if (isIndexExpr(expr)) {
            const receiver = this.infer(expr.receiver, env);
            const index = this.infer(expr.index, env);
            if (receiver.kind === 'error' || index.kind === 'error') return ERROR;
            if (receiver.kind === 'list' && is(index, 'Int')) return receiver.item;
            return this.problem(expr, `${show(receiver)} cannot be indexed by ${show(index)}.`);
        }
        if (isNameExpr(expr)) return expr.call ? this.callFunction(expr, env) : this.name(expr, env, expected);
        if (isMemberExpr(expr)) return expr.call ? this.callMethod(expr, env) : this.member(expr, env);
        return ERROR;
    }

    /** Where an enum is expected, its value wins over a field or parameter of the same name. */
    private name(expr: NameExpr, env: Env, expected?: Type): Type {
        const literal = expected?.kind === 'decl' && isEnum(expected.decl) ? expected.decl.literals.find(l => l.name === expr.name) : undefined;
        if (literal) {
            this.targets.set(expr, literal);
            return { kind: 'decl', decl: literal.$container };
        }
        const binding = env.get(expr.name);
        if (binding) {
            if (binding.target) this.targets.set(expr, binding.target);
            return binding.type;
        }
        if (expr.name === 'tenant') {
            const declared = this.tenants.length === 0 ? 'declares no tenant' : `declares ${this.tenants.length} tenants`;
            return this.problem(expr, `"tenant" needs exactly one tenant in the workspace, which ${declared}.`, 'name');
        }
        if (AstUtils.getContainerOfType(expr, isRole)) return this.problem(expr, `A role condition reads only actor, tenant and now, not "${expr.name}".`, 'name');
        return this.problem(expr, `Unknown name "${expr.name}".`, 'name');
    }

    private member(expr: MemberExpr, env: Env): Type {
        const qualified = this.enumValue(expr, env);
        if (qualified) return qualified;
        const receiver = this.infer(expr.receiver, env);
        if (receiver.kind === 'error') return ERROR;
        const sources = this.fieldSources(receiver);
        const fields = [...new Set(sources?.flatMap(list => list.filter(f => f.name === expr.member)))];
        if (!fields.length) return this.problem(expr, `${show(receiver)} has no field "${expr.member}".`, 'member');
        this.targets.set(expr, fields[0]);
        if (fields.length > 1) this.candidates.set(expr, fields);
        // Optional when some actor or some type of a union has no such field.
        const partial = sources!.some(list => !list.some(f => f.name === expr.member));
        const type = union(fields.map(f => typeOfRef(f.type)));
        return receiver.optional || partial ? { ...type, optional: true } : type;
    }

    /** A value named with its enum, such as `Status.open` or `sales.Status.open`, when the receiver is no name in scope. */
    private enumValue(expr: MemberExpr, env: Env): Type | undefined {
        const path = pathOf(expr.receiver);
        if (!path || env.has(path.split('.')[0])) return undefined;
        const scope = this.services.references.ScopeProvider as ApplingScopeProvider;
        const decl = scope.lookup(expr, 'Enum', path);
        if (!isEnum(decl)) return undefined;
        const literal = decl.literals.find(l => l.name === expr.member);
        if (!literal) return this.problem(expr, `Enum ${decl.name} has no value "${expr.member}".`, 'member');
        this.targets.set(expr, literal);
        return { kind: 'decl', decl };
    }

    private binary(expr: BinaryExpr, env: Env): Type {
        const { op } = expr;
        if (op === '||' || op === '&&') {
            const left = this.infer(expr.left, env);
            const right = this.infer(expr.right, env);
            if (left.kind === 'error' || right.kind === 'error') return primitive('Bool');
            return is(left, 'Bool') && is(right, 'Bool') ? primitive('Bool') : this.mismatch(expr, left, right);
        }
        if (op === 'in') {
            const left = this.infer(expr.left, env);
            const right = this.infer(expr.right, env, { kind: 'list', item: left });
            if (left.kind === 'error' || right.kind === 'error') return primitive('Bool');
            return right.kind === 'list' && comparable(left, right.item) ? primitive('Bool') : this.mismatch(expr, left, right);
        }
        const [left, right] = this.operands(expr, env);
        if (left.kind === 'error' || right.kind === 'error') return ['==', '!=', '<', '<=', '>', '>='].includes(op) ? primitive('Bool') : ERROR;
        if (op === '==' || op === '!=') return comparable(this.asEntity(left, right), this.asEntity(right, left)) ? primitive('Bool') : this.mismatch(expr, left, right);
        if (op === '<' || op === '<=' || op === '>' || op === '>=') {
            return comparable(left, right) && is(left, ...ORDERED) ? primitive('Bool') : this.mismatch(expr, left, right);
        }
        return arithmetic(op, left, right) ?? this.mismatch(expr, left, right);
    }

    /** Types both operands; a bare enum literal on either side takes its type from the other side. */
    private operands(expr: BinaryExpr, env: Env): [Type, Type] {
        const unbound = (e: Expr) => isNameExpr(e) && !e.call && !env.has(e.name);
        if (unbound(expr.left) && !unbound(expr.right)) {
            const right = this.infer(expr.right, env);
            return [this.infer(expr.left, env, right), right];
        }
        const left = this.infer(expr.left, env);
        return [left, this.infer(expr.right, env, left)];
    }

    /** The actor compares with the entity some actor is bound to, such as `customer == actor`. */
    private asEntity(type: Type, other: Type): Type {
        if (type.kind !== 'actor' || other.kind !== 'decl') return type;
        return this.actors.some(a => a.entity?.ref === other.decl) ? { kind: 'decl', decl: other.decl } : type;
    }

    private callFunction(expr: NameExpr, env: Env): Type {
        if (!FUNCTIONS.includes(expr.name)) return this.problem(expr, `Unknown function "${expr.name}".`, 'name');
        if (expr.args.length !== 1) return this.problem(expr, `${expr.name}() takes 1 argument, got ${expr.args.length}.`);
        const arg = this.infer(expr.args[0], env);
        if (arg.kind === 'error') return ERROR;
        switch (expr.name) {
            case 'duration':
                return is(arg, ...TEXT) ? primitive('Duration') : this.problem(expr, `duration() takes a String, not ${show(arg)}.`);
            case 'size':
                return arg.kind === 'list' || is(arg, ...TEXT) ? primitive('Int') : this.problem(expr, `size() takes a list or String, not ${show(arg)}.`);
            case 'has':
                return primitive('Bool');
            default:
                return arg.kind === 'list' && is(arg.item, ...NUMERIC, 'Duration') ? { ...arg.item, optional: false }
                    : this.problem(expr, `${expr.name}() takes a list of numbers, not ${show(arg)}.`);
        }
    }

    private callMethod(expr: MemberExpr, env: Env): Type {
        const receiver = this.infer(expr.receiver, env);
        if (receiver.kind === 'error') return ERROR;
        if (receiver.kind === 'actor' && expr.member === 'is') return this.actorIs(expr);
        if (receiver.kind === 'list' && MACROS.includes(expr.member)) return this.macro(expr, receiver.item, env);
        const args = expr.args.map(a => this.infer(a, env));
        if (args.some(a => a.kind === 'error')) return ERROR;
        if (expr.member === 'size' && args.length === 0 && (receiver.kind === 'list' || is(receiver, ...TEXT))) return primitive('Int');
        if (STRING_METHODS.includes(expr.member) && is(receiver, ...TEXT) && args.length === 1 && is(args[0], ...TEXT)) return primitive('Bool');
        return this.problem(expr, `${show(receiver)} has no method "${expr.member}" for these arguments.`, 'member');
    }

    private actorIs(expr: MemberExpr): Type {
        const [arg] = expr.args;
        const name = arg && expr.args.length === 1 ? pathOf(arg) : undefined;
        if (!name) return this.problem(expr, 'actor.is() takes one role or actor name.');
        const scope = this.services.references.ScopeProvider as ApplingScopeProvider;
        const target = scope.lookup(expr, 'Role', name) ?? scope.lookup(expr, 'Actor', name);
        if (!target) return this.problem(arg, `"${name}" is not a role or actor.`);
        this.targets.set(arg, target);
        return primitive('Bool');
    }

    /** `list.map(x, body)` and friends: `x` is bound to the item type inside `body`. */
    private macro(expr: MemberExpr, item: Type, env: Env): Type {
        const [variable, body] = expr.args;
        if (expr.args.length !== 2 || !isNameExpr(variable) || variable.call) {
            return this.problem(expr, `${expr.member}() takes a variable name and an expression.`);
        }
        const result = this.infer(body, new Map([...env, [variable.name, { type: item }]]));
        if (result.kind === 'error') return ERROR;
        if (expr.member === 'map') return { kind: 'list', item: result };
        if (!is(result, 'Bool')) return this.problem(body, `A condition must be Bool, not ${show(result)}.`);
        return expr.member === 'filter' ? { kind: 'list', item } : primitive('Bool');
    }

    /** The field lists a member of the type may come from: one per actor, one per type of a union. */
    private fieldSources(type: Type): Field[][] | undefined {
        if (type.kind === 'actor') return this.actors.map(actorFields);
        if (type.kind === 'decl' && !isEnum(type.decl)) return [type.decl.fields];
        if (type.kind === 'union') {
            const lists = type.types.map(t => this.fieldSources(t));
            return lists.some(l => l === undefined) ? undefined : lists.flatMap(l => l!);
        }
        return undefined;
    }

    private assignmentTarget(assignment: Assignment): Type | undefined {
        const effect = assignment.$container;
        const owner: Entity | Event | undefined = isCreateEffect(effect) ? effect.entity.ref : effect.event.ref;
        if (!owner) return undefined;
        const field = owner.fields.find(f => f.name === assignment.name);
        if (!field) {
            this.problem(assignment, `${owner.name} has no field "${assignment.name}".`, 'name');
            return undefined;
        }
        this.targets.set(assignment, field);
        return typeOfRef(field.type);
    }

    private base(): Env {
        const env: Env = new Map([['actor', { type: ACTOR }], ['now', { type: primitive('DateTime') }]]);
        const tenant = this.tenants.length === 1 ? this.tenants[0].entity.ref : undefined;
        if (tenant) env.set('tenant', { type: { kind: 'decl', decl: tenant }, target: this.tenants[0] });
        return env;
    }

    private with(outer: Env, fields: (Field | Param)[], self?: Entity): Env {
        const env = new Map(outer);
        if (self) env.set('this', { type: { kind: 'decl', decl: self } });
        for (const f of fields) env.set(f.name, { type: typeOfRef(f.type), target: f });
        return env;
    }

    private entityEnv(entity: Entity | undefined): Env {
        return this.with(this.base(), entity?.fields ?? [], entity);
    }

    private fieldsEnv(container: Field['$container']): Env {
        return isEntity(container) ? this.entityEnv(container) : this.with(this.base(), container.fields);
    }

    private actionEnv(action: Action | undefined): Env {
        return this.with(this.entityEnv(action?.entity?.ref), action?.inputs ?? []);
    }

    /** A query's filter and policies read the entity's fields and the query's inputs, which shadow fields of the same name. */
    private queryEnv(query: Query): Env {
        return this.with(this.entityEnv(query.entity.ref), query.inputs);
    }

    private paramsEnv(params: Param[]): Env {
        return this.with(this.base(), params);
    }

    private policyEnv(policy: Policy): Env {
        const owner = policy.$container;
        if (isEntity(owner)) return this.entityEnv(owner);
        if (isAction(owner)) return this.actionEnv(owner);
        if (isQuery(owner)) return this.queryEnv(owner);
        return this.paramsEnv(owner.params);
    }

    /**
     * The names inside an effect: those of its action or transition, then the variable of every enclosing `for`
     * and the `as` name of every earlier `create` in the same or an enclosing effect block.
     */
    private effectEnv(effect: AstNode): Env {
        const action = AstUtils.getContainerOfType(effect, isAction);
        const transition = AstUtils.getContainerOfType(effect, isTransition);
        const env = action ? this.actionEnv(action) : this.entityEnv(transition && machineEntity(transition));
        const chain: AstNode[] = [];
        for (let node: AstNode | undefined = effect; node && node !== action && node !== transition; node = node.$container) chain.unshift(node);
        chain.forEach((node, i) => {
            const block = isEffect(node) ? (node.$container as { effects?: AstNode[] }).effects : undefined;
            for (const earlier of block?.slice(0, block.indexOf(node)) ?? []) {
                if (isCreateEffect(earlier) && earlier.variable && earlier.entity.ref) env.set(earlier.variable, { type: { kind: 'decl', decl: earlier.entity.ref } });
            }
            if (isForEffect(node) && i < chain.length - 1 && node.collection.ref) {
                const type = typeOfRef(node.collection.ref.type);
                env.set(node.variable, { type: type.kind === 'list' ? type.item : ERROR });
            }
        });
        return env;
    }

    /** Inside `update path { … }`: the names of the effect, with the fields of the updated record in front. */
    private updateEnv(update: UpdateEffect): Env {
        const env = this.effectEnv(update);
        let type = this.types.get(update.target);
        if (!type) {
            // Typed here before its own turn: keep its problems for then, so they are reported once.
            const reported = this.problems.length;
            type = this.infer(update.target, env);
            this.problems.length = reported;
        }
        return type.kind === 'decl' && isEntity(type.decl) ? this.with(env, type.decl.fields) : env;
    }

    private mismatch(expr: BinaryExpr, left: Type, right: Type): Type {
        return this.problem(expr, `Operator "${expr.op}" does not apply to ${show(left)} and ${show(right)}.`);
    }

    private problem(node: AstNode, message: string, property?: string): Type {
        this.problems.push({ node, message, property });
        return ERROR;
    }
}

export function typeOfRef(ref: TypeRef): Type {
    const decl = ref.decl?.ref;
    const base: Type = ref.primitive ? primitive(ref.primitive) : decl ? { kind: 'decl', decl } : ERROR;
    const type: Type = ref.many ? { kind: 'list', item: base } : base;
    return ref.optional ? { ...type, optional: true } : type;
}

export function show(type: Type): string {
    const optional = type.optional ? '?' : '';
    switch (type.kind) {
        case 'primitive': return type.name + optional;
        case 'decl': return type.decl.name + optional;
        case 'list': return `${show(type.item)}[]${optional}`;
        case 'union': {
            const types = type.types.map(show).join(' | ');
            return optional ? `(${types})?` : types;
        }
        case 'error': return 'unknown';
        default: return type.kind;
    }
}

function primitive(name: string): Type {
    return { kind: 'primitive', name };
}

function is(type: Type, ...names: string[]): type is Type & { kind: 'primitive'; name: string } {
    return type.kind === 'primitive' && names.includes(type.name);
}

/** One type, or a union of the distinct ones (as shown, ignoring optional). */
function union(types: Type[]): Type {
    const distinct = [...new Map(types.map(t => [show({ ...t, optional: false }), t])).values()];
    if (distinct.length === 1) return types.some(t => t.optional) ? { ...distinct[0], optional: true } : distinct[0];
    return { kind: 'union', types: distinct.map(t => ({ ...t, optional: false })), optional: types.some(t => t.optional) };
}

function comparable(a: Type, b: Type): boolean {
    if (a.kind === 'union') return a.types.some(t => comparable(t, b));
    if (b.kind === 'union') return b.types.some(t => comparable(a, t));
    if (a.kind === 'error' || b.kind === 'error' || a.kind === 'null' || b.kind === 'null') return true;
    if (is(a, ...NUMERIC) && is(b, ...NUMERIC)) return true;
    if (is(a, ...TEXT) && is(b, ...TEXT)) return true;
    if (a.kind === 'primitive' && b.kind === 'primitive') return a.name === b.name;
    if (a.kind === 'decl' && b.kind === 'decl') return a.decl === b.decl;
    if (a.kind === 'list' && b.kind === 'list') return comparable(a.item, b.item);
    return false;
}

function assignable(value: Type, target: Type): boolean {
    if (value.kind === 'error' || target.kind === 'error') return true;
    if (value.kind === 'null') return target.optional === true;
    if (value.kind === 'union') return value.types.some(t => assignable(value.optional ? { ...t, optional: true } : t, target));
    if (is(target, ...NUMERIC) && is(value, ...NUMERIC)) return NUMERIC.indexOf(value.name) <= NUMERIC.indexOf(target.name);
    if (value.kind === 'list' && target.kind === 'list') return assignable(value.item, target.item);
    return comparable(value, target) && value.kind === target.kind;
}

function arithmetic(op: string, a: Type, b: Type): Type | undefined {
    const plain = (t: Type): Type => ({ ...t, optional: false });
    if (is(a, ...NUMERIC) && is(b, ...NUMERIC)) return plain(NUMERIC.indexOf(a.name) >= NUMERIC.indexOf(b.name) ? a : b);
    if (op === '+' && is(a, ...TEXT) && is(b, ...TEXT)) return primitive('String');
    if ((op === '+' || op === '-') && is(a, ...TEMPORAL, 'Duration') && is(b, 'Duration')) return plain(a);
    if (op === '-' && is(a, ...TEMPORAL) && is(b, ...TEMPORAL)) return primitive('Duration');
    if ((op === '*' || op === '/') && is(a, 'Duration') && is(b, ...NUMERIC)) return primitive('Duration');
    if (op === '+' && a.kind === 'list' && b.kind === 'list' && comparable(a.item, b.item)) return plain(a);
    return undefined;
}

function signature(target: NonNullable<Call['target']['ref']>): Signature {
    const params = (list: Param[]) => list.map(p => typeOfRef(p.type));
    const required = (list: Param[], offset = 0) => offset + list.filter(p => !p.type.optional).length;
    if (isAction(target)) {
        const entity: Type[] = target.entity?.ref ? [{ kind: 'decl', decl: target.entity.ref }] : [];
        return { params: [...entity, ...params(target.inputs)], required: required(target.inputs, entity.length) };
    }
    if (isExternalOperation(target) || isUseCase(target)) return { params: params(target.params), required: required(target.params) };
    return { params: params(target.inputs), required: required(target.inputs) };
}

/** An actor's own fields and those of the entity it is bound to. */
function actorFields(actor: Actor): Field[] {
    return [...actor.fields, ...(actor.entity?.ref?.fields ?? [])];
}

function machineEntity(transition: Transition): Entity | undefined {
    const owner = transition.$container.field.ref?.$container;
    return isEntity(owner) ? owner : undefined;
}

/** The dotted name written by a plain name or member chain, such as `crm.Clerk`. */
function pathOf(expr: Expr): string | undefined {
    if (isNameExpr(expr) && !expr.call) return expr.name;
    if (isMemberExpr(expr) && !expr.call) {
        const receiver = pathOf(expr.receiver);
        return receiver && `${receiver}.${expr.member}`;
    }
    return undefined;
}

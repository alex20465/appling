import type { ExprData, Graph, GraphNode, TypeData } from './graph.js';
import { throughPath } from './effects.js';

/** A value the simulator could not know, such as a field of a record that was not given. Logic treats it as "maybe". */
export const UNKNOWN: unique symbol = Symbol('unknown');

/** UNKNOWN is the only symbol a value can be. */
export type Value = string | number | boolean | null | Date | Value[] | Record | symbol;

/** A record of an entity or value type, by field name; `$type` is the qualified name of its declaration. */
export interface Record {
    [field: string]: Value | string | undefined;
    $type?: string;
}

export interface Actor {
    /** Qualified name of a declared actor. */
    actor: string;
    fields?: { [field: string]: Value };
}

export type Verdict = 'yes' | 'no' | 'depends';

export interface RunResult {
    allowed: Verdict;
    outcome: 'done' | 'refused' | 'error';
    /** Why the action did not run: a failed precondition, a missing transition, a policy. */
    reasons: string[];
    before: Record;
    after?: Record;
    events: { event: string, fields: { [name: string]: Value } }[];
    /** The records the effects create, update or delete besides the action's own, in the order they ran; UNKNOWN when a path leads to a record that was not given. */
    writes: Write[];
    /** True when the action deletes its own record (`delete self`); its invariants are then not checked. */
    deleted?: boolean;
    violated: string[];
}

export interface Write {
    /** The qualified name of the effect. */
    effect: string;
    operation: 'create' | 'update' | 'delete';
    /** The qualified name of the record's entity. */
    entity: string;
    /** A copy of the record right after the effect: a created row with its assigned fields, an updated one with its new values. */
    record: Record | typeof UNKNOWN;
}

type Scope = { self?: Record, actor?: Actor, inputs?: { [name: string]: Value }, vars?: Map<string, Value> };

/** One thing an actor may try, with the verdict of the policies that guard it. */
export interface Access {
    /** The qualified name of an entity, action, query, use case or page. */
    target: string;
    /** For an entity: the operation, and the fields when a policy guards only some of them. */
    operation?: 'read' | 'create' | 'update' | 'delete';
    fields?: string[];
    verdict: Verdict;
    /** The qualified names of the deciding policies; none means nothing grants the target, so nobody may. */
    policies: string[];
}

const OPERATIONS = ['read', 'create', 'update', 'delete'] as const;

const MS: { [unit: string]: number } = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * Evaluates the behavior of a model against sample data and actors, as described in concept.md section 5:
 * which states a machine can reach, which actors may trigger an action, what one actor may do, which invariants
 * an action puts at risk, and what running an action on a record does.
 */
export class Simulator {

    private readonly nodes: Map<string, GraphNode>;
    private readonly children = new Map<string, GraphNode[]>();

    constructor(readonly graph: Graph, private readonly now = new Date()) {
        this.nodes = new Map(graph.nodes.map(n => [n.qn, n]));
        for (const edge of graph.edges.filter(e => e.kind === 'contains')) {
            this.children.set(edge.from, [...(this.children.get(edge.from) ?? []), this.nodes.get(edge.to)!]);
        }
    }

    /**
     * The shortest sequence of transitions from one of the machine's initial states to the target state, or undefined.
     * The initial states are the field's default and every state a `create` assigns; without either, every state.
     */
    reach(machine: string, state: string): { from: string, path: { transition: string, trigger: string, to: string, guarded: boolean }[] } | undefined {
        const node = this.node(machine);
        const field = this.node(node.data.field as string);
        const created = this.graph.nodes
            .filter(n => n.kind === 'CreateEffect' && n.data.entity === this.parentOf(field.qn))
            .flatMap(n => (n.data.assignments as { name: string, value: ExprData }[] | undefined) ?? [])
            .filter(a => a.name === last(field.qn) && a.value.target)
            .map(a => last(a.value.target!));
        const initial = [(field.data.default as ExprData | undefined)?.name, ...created].filter(s => s !== undefined);
        const starts = initial.length ? [...new Set(initial)] : this.kids(this.node((field.data.type as TypeData).decl!)).map(l => last(l.qn));
        const transitions = this.kids(node, 'Transition');
        for (const start of starts) {
            const seen = new Map<string, { transition: string, trigger: string, to: string, guarded: boolean }[]>([[start, []]]);
            const queue = [start];
            while (queue.length) {
                const current = queue.shift()!;
                if (current === state) return { from: start, path: seen.get(current)! };
                for (const t of transitions.filter(t => (t.data.from as string[]).includes(current))) {
                    const to = t.data.to as string;
                    if (seen.has(to)) continue;
                    seen.set(to, [...seen.get(current)!, { transition: t.qn, trigger: last((t.data.action ?? t.data.event) as string), to, guarded: !!t.data.guard }]);
                    queue.push(to);
                }
            }
        }
        return undefined;
    }

    /** For every declared actor: whether it may trigger the action, by the action's policies, the entity's update policies and the create policies of what it creates. */
    actors(action: string): { actor: string, verdict: Verdict }[] {
        return this.graph.nodes.filter(n => n.kind === 'Actor').map(actor => ({
            actor: actor.qn,
            verdict: this.permitted(action, { actor: actor.qn }, undefined)
        }));
    }

    /**
     * What an actor may do: every entity operation, action, query, use case and page with the verdict of its
     * policies. Policies add up along the reference path (concept.md section 3): an action also needs its entity's
     * update policies and the create policies of the entities it creates, a query its entity's read policies, a use
     * case the policies of everything its steps call, and a page the policies of the queries and projections it
     * shows. The actions a page offers keep their own.
     */
    access(actor: string): Access[] {
        const verdict = (policies: GraphNode[]): Verdict => this.verdict(policies, { actor }, undefined, {});
        const result: Access[] = [];
        for (const entity of this.graph.nodes.filter(n => n.kind === 'Entity')) {
            for (const operation of OPERATIONS) {
                const whole = this.entityPolicies(entity.qn, operation);
                result.push({ target: entity.qn, operation, verdict: verdict(whole), policies: whole.map(p => p.qn) });
                for (const partial of this.kids(entity, 'Policy').filter(p => fieldsOf(p).length && covers(p, operation))) {
                    result.push({ target: entity.qn, operation, fields: fieldsOf(partial).map(last), verdict: verdict([...whole, partial]), policies: [...whole, partial].map(p => p.qn) });
                }
            }
        }
        for (const node of this.graph.nodes.filter(n => ['Action', 'Query', 'UseCase', 'Page'].includes(n.kind))) {
            const policies = [...new Set(this.guards(node.qn))];
            result.push({ target: node.qn, verdict: verdict(policies), policies: policies.map(p => p.qn) });
        }
        return result;
    }

    /** The invariants of the action's entity that read a field the action changes, directly or through derived fields. */
    risks(action: string): { invariant: string, fields: string[] }[] {
        const node = this.node(action);
        const entity = node.data.entity as string | undefined;
        if (!entity) return [];
        const changed = new Set<string>();
        for (const effect of this.ownSets(node)) changed.add(effect.data.field as string);
        for (const transition of this.graph.nodes.filter(n => n.kind === 'Transition' && n.data.action === action)) {
            changed.add(this.node(this.parentOf(transition.qn)).data.field as string);
            for (const effect of this.ownSets(transition)) changed.add(effect.data.field as string);
        }
        const reads = (qn: string): Set<string> => {
            const direct = this.graph.edges.filter(e => e.from === qn && e.kind === 'uses').map(e => e.to);
            const derived = direct.filter(f => this.nodes.get(f)?.data.derived).flatMap(f => [...reads(f)]);
            return new Set([...direct, ...derived]);
        };
        return this.kids(this.node(entity), 'Invariant').flatMap(invariant => {
            const fields = [...reads(invariant.qn)].filter(f => changed.has(f));
            return fields.length ? [{ invariant: invariant.qn, fields: fields.map(last) }] : [];
        });
    }

    /** Runs an action on a record as an actor: policies, preconditions, the state transition, effects, then the invariants. */
    run(action: string, record: Record, actor: Actor, inputs: { [name: string]: Value } = {}): RunResult {
        const node = this.node(action);
        const entity = node.data.entity as string | undefined;
        const before: Record = { ...record, $type: entity };
        const result: RunResult = { allowed: this.permitted(action, actor, before, inputs), outcome: 'done', reasons: [], before, events: [], writes: [], violated: [] };
        if (result.allowed === 'no') return { ...result, outcome: 'refused', reasons: ['no policy allows this actor'] };
        const scope = { self: before, actor, inputs };
        const preconditions = (node.data.preconditions ?? []) as { condition: ExprData, error?: string }[];
        preconditions.forEach((precondition, i) => {
            if (this.evaluate(precondition.condition, scope) === false) result.reasons.push(precondition.error ? last(precondition.error) : (node.props.preconditions as string[])[i]);
        });
        if (result.reasons.length) return { ...result, outcome: 'error' };
        // A deep copy, so updates of related records change the copy and not the given data.
        const after = clone(before) as Record;
        const transitions = this.graph.nodes.filter(n => n.kind === 'Transition' && n.data.action === action);
        if (transitions.length) {
            const field = last(this.node(this.parentOf(transitions[0].qn)).data.field as string);
            const taken = transitions.find(t => (t.data.from as string[]).includes(String(before[field])) && (!t.data.guard || this.evaluate(t.data.guard as ExprData, scope) !== false));
            if (!taken) return { ...result, outcome: 'error', reasons: [`no transition of ${last(this.parentOf(transitions[0].qn))} from ${String(before[field])}`] };
            this.effects(taken, after, scope, result);
            after[field] = taken.data.to as string;
        }
        this.effects(node, after, scope, result);
        result.after = after;
        if (entity && !result.deleted) {
            for (const invariant of this.kids(this.node(entity), 'Invariant')) {
                if (this.evaluate(invariant.data.condition as ExprData, { self: after, actor, inputs }) === false) result.violated.push(String(invariant.data.label));
            }
        }
        return result;
    }

    /** Evaluates an expression; anything that depends on data that is not given comes back as UNKNOWN. */
    evaluate(expr: ExprData, scope: Scope): Value {
        const sub = (e: ExprData) => this.evaluate(e, scope);
        switch (expr.$type) {
            case 'StringExpr': return String(expr.value);
            case 'NumberExpr': return Number(expr.value);
            case 'BoolExpr': return expr.value === 'true';
            case 'NullExpr': return null;
            case 'ListExpr': return (expr.items ?? []).map(sub);
            case 'UnaryExpr': {
                const value = sub(expr.operand!);
                if (value === UNKNOWN) return UNKNOWN;
                return expr.op === '!' ? !value : -(value as number);
            }
            case 'BinaryExpr': return this.binary(expr, scope);
            case 'IndexExpr': {
                const [list, index] = [sub(expr.receiver!), sub(expr.index!)];
                return Array.isArray(list) && typeof index === 'number' ? list[index] ?? null : UNKNOWN;
            }
            case 'NameExpr': return expr.call ? this.call(expr, scope) : this.name(expr, scope);
            case 'MemberExpr': return expr.call ? this.method(expr, scope) : this.member(sub(expr.receiver!), expr.member!, expr.target, scope);
        }
    }

    private permitted(action: string, actor: Actor, record: Record | undefined, inputs: { [name: string]: Value } = {}): Verdict {
        return this.verdict(this.guards(action), actor, record, inputs);
    }

    private verdict(policies: GraphNode[], actor: Actor, record: Record | undefined, inputs: { [name: string]: Value }): Verdict {
        const verdicts = policies.map(p => this.evaluate(p.data.condition as ExprData, { self: record, actor, inputs }));
        if (!verdicts.length || verdicts.some(v => v === false)) return 'no';
        return verdicts.every(v => v === true) ? 'yes' : 'depends';
    }

    /** The policies an action, query, use case, projection or page needs, its own and those along the reference path. */
    private guards(qn: string, seen = new Set<string>()): GraphNode[] {
        if (seen.has(qn)) return [];
        seen.add(qn);
        const node = this.node(qn);
        const own = this.kids(node, 'Policy');
        const along = (targets: (string | undefined)[]) => targets.filter(t => t).flatMap(t => this.guards(t!, seen));
        switch (node.kind) {
            case 'Action': {
                const transitions = this.graph.nodes.filter(n => n.kind === 'Transition' && n.data.action === qn);
                const effects = [node, ...transitions].flatMap(n => this.effectsBelow(n));
                const along = (kind: string, operation: string) => [...new Set(effects.filter(e => e.kind === kind).map(e => e.data.entity as string | undefined))]
                    .flatMap(e => this.entityPolicies(e, operation));
                return [...own, ...this.entityPolicies(node.data.entity as string | undefined, 'update'),
                    ...along('CreateEffect', 'create'), ...along('UpdateEffect', 'update'), ...along('DeleteEffect', 'delete')];
            }
            case 'Query': return [...own, ...this.entityPolicies(node.data.entity as string, 'read')];
            case 'Entity': return this.entityPolicies(qn, 'read');
            case 'Projection': return along([node.data.source as string]);
            case 'UseCase': {
                const steps = (node.data.steps ?? []) as { call?: { target: string }, handlers?: { call: { target: string } }[] }[];
                return [...own, ...along(steps.flatMap(s => [s.call, ...(s.handlers ?? []).map(h => h.call)]).map(c => c?.target))];
            }
            case 'Page': {
                const components = (node.data.components ?? []) as { query?: string, projection?: string }[];
                return along(components.flatMap(c => [c.query, c.projection]));
            }
            default: return own;
        }
    }

    /** The policies of an entity that guard a whole record for an operation. */
    private entityPolicies(entity: string | undefined, operation: string): GraphNode[] {
        return entity ? this.kids(this.node(entity), 'Policy').filter(p => !fieldsOf(p).length && covers(p, operation)) : [];
    }

    /** Runs the effects below an action, transition or loop in order; an `as` name binds the created row for the effects after it. */
    private effects(owner: GraphNode, record: Record, scope: Scope, result: RunResult): void {
        let current = scope;
        for (const effect of this.kids(owner).filter(k => k.kind.endsWith('Effect'))) {
            const created = this.apply(effect, record, current, result);
            const variable = effect.data.variable as string | undefined;
            if (created && variable) current = { ...current, vars: new Map([...(current.vars ?? []), [variable, created]]) };
        }
    }

    /** Applies one effect to the record; returns the row a `create` made. */
    private apply(effect: GraphNode, record: Record, scope: Scope, result: RunResult): Record | undefined {
        const own = { ...scope, self: record };
        const entity = effect.data.entity as string;
        switch (effect.kind) {
            case 'SetEffect':
                record[last(effect.data.field as string)] = this.evaluate(effect.data.value as ExprData, own);
                return undefined;
            case 'ForEffect': {
                // A collection that was not given runs no iteration.
                const items = record[last(effect.data.collection as string)];
                for (const item of Array.isArray(items) ? [...items] : []) {
                    this.effects(effect, record, { ...scope, vars: new Map([...(scope.vars ?? []), [effect.data.variable as string, item]]) }, result);
                }
                return undefined;
            }
            case 'UpdateEffect': {
                const path = effect.data.target as ExprData;
                const target = this.evaluate(path, own);
                if (!isRecord(target)) {
                    if (target !== null) result.writes.push({ effect: effect.qn, operation: 'update', entity, record: UNKNOWN });
                    return undefined;
                }
                // Every value is read before any is written, as one update of the row.
                const values = this.kids(effect, 'SetEffect').map(set => [last(set.data.field as string), this.evaluate(throughPath(set.data.value as ExprData, entity, path), own)] as const);
                for (const [field, value] of values) target[field] = value;
                result.writes.push({ effect: effect.qn, operation: 'update', entity, record: clone(target) as Record });
                return undefined;
            }
            case 'DeleteEffect': {
                if (effect.data.self) {
                    result.deleted = true;
                    result.writes.push({ effect: effect.qn, operation: 'delete', entity, record: clone(record) as Record });
                    return undefined;
                }
                const target = this.evaluate(effect.data.target as ExprData, own);
                if (target === null) return undefined;
                if (isRecord(target)) detach(record, target);
                result.writes.push({ effect: effect.qn, operation: 'delete', entity, record: isRecord(target) ? clone(target) as Record : UNKNOWN });
                return undefined;
            }
        }
        const fields = Object.fromEntries(((effect.data.assignments ?? []) as { name: string, value: ExprData }[]).map(a => [a.name, this.evaluate(a.value, own)]));
        if (effect.kind === 'EmitEffect') {
            result.events.push({ event: effect.data.event as string, fields });
            return undefined;
        }
        if (effect.kind !== 'CreateEffect') return undefined;
        const created: Record = { $type: entity, ...fields };
        result.writes.push({ effect: effect.qn, operation: 'create', entity, record: clone(created) as Record });
        return created;
    }

    /** The effects below a node at any depth, inside loops and updates too. */
    private effectsBelow(node: GraphNode): GraphNode[] {
        return this.kids(node).filter(k => k.kind.endsWith('Effect')).flatMap(e => [e, ...this.effectsBelow(e)]);
    }

    /** The sets that change the record itself, inside loops too, but not those of an `update` of a related record. */
    private ownSets(node: GraphNode): GraphNode[] {
        return this.kids(node).filter(k => k.kind.endsWith('Effect') && k.kind !== 'UpdateEffect').flatMap(e => e.kind === 'SetEffect' ? [e] : this.ownSets(e));
    }

    private binary(expr: ExprData, scope: Scope): Value {
        const [left, right] = [this.evaluate(expr.left!, scope), this.evaluate(expr.right!, scope)];
        switch (expr.op) {
            case '&&': return left === false || right === false ? false : left === UNKNOWN || right === UNKNOWN ? UNKNOWN : true;
            case '||': return left === true || right === true ? true : left === UNKNOWN || right === UNKNOWN ? UNKNOWN : false;
        }
        if (left === UNKNOWN || right === UNKNOWN) return UNKNOWN;
        const [a, b] = [comparable(left), comparable(right)];
        switch (expr.op) {
            case '==': return equal(left, right);
            case '!=': return !equal(left, right);
            case '<': return (a as number) < (b as number);
            case '<=': return (a as number) <= (b as number);
            case '>': return (a as number) > (b as number);
            case '>=': return (a as number) >= (b as number);
            case 'in': return Array.isArray(right) ? right.some(item => equal(item, left)) : UNKNOWN;
            case '+': return left instanceof Date ? new Date(left.getTime() + (b as number)) : Array.isArray(left) ? [...left, ...(right as Value[])] : typeof left === 'string' ? left + String(right) : (a as number) + (b as number);
            case '-': return left instanceof Date && right instanceof Date ? left.getTime() - right.getTime() : left instanceof Date ? new Date(left.getTime() - (b as number)) : (a as number) - (b as number);
            case '*': return (a as number) * (b as number);
            case '/': return (a as number) / (b as number);
            case '%': return (a as number) % (b as number);
        }
        return UNKNOWN;
    }

    private name(expr: ExprData, scope: Scope): Value {
        const id = expr.name!;
        if (scope.vars?.has(id)) return scope.vars.get(id)!;
        if (!expr.target) {
            if (id === 'this') return scope.self ?? UNKNOWN;
            if (id === 'now') return this.now;
            if (id === 'actor') return scope.actor ? ({ $type: scope.actor.actor, ...scope.actor.fields } as Record) : UNKNOWN;
            return UNKNOWN;
        }
        const target = this.nodes.get(expr.target);
        if (target?.kind === 'EnumLiteral') return id;
        if (target?.kind === 'Param') return scope.inputs && id in scope.inputs ? scope.inputs[id] : UNKNOWN;
        if (target?.kind === 'Field') return this.member(scope.self ?? UNKNOWN, id, expr.target, scope);
        return UNKNOWN;
    }

    /** A field of a null record is null, as the typer makes it optional; an actor's field that neither it nor its entity declares is null too. */
    private member(receiver: Value, member: string, target: string | undefined, scope: Scope): Value {
        if (receiver === null) return null;
        if (receiver === UNKNOWN || typeof receiver !== 'object' || Array.isArray(receiver) || receiver instanceof Date) return UNKNOWN;
        if (member in receiver) return receiver[member] as Value;
        const actor = this.nodes.get(receiver.$type ?? '');
        if (actor?.kind === 'Actor' && ![receiver.$type, actor.data.entity].some(owner => this.nodes.has(`${owner}.${member}`))) return null;
        const field = target ? this.nodes.get(target) : undefined;
        if (field?.data.derived) return this.evaluate(field.data.derived as ExprData, { ...scope, self: receiver, vars: undefined });
        return UNKNOWN;
    }

    private call(expr: ExprData, scope: Scope): Value {
        const [arg] = expr.args ?? [];
        if (expr.name === 'duration') {
            const parts = [...String(arg?.value ?? '').matchAll(/(\d+(?:\.\d+)?)(ms|d|h|m|s)/g)];
            return parts.reduce((total, [, amount, unit]) => total + Number(amount) * MS[unit], 0);
        }
        const value = arg ? this.evaluate(arg, scope) : UNKNOWN;
        if (expr.name === 'has') return value === UNKNOWN ? UNKNOWN : value !== null && value !== undefined;
        if (value === UNKNOWN) return UNKNOWN;
        const list = Array.isArray(value) ? value.map(v => comparable(v) as number) : [];
        switch (expr.name) {
            case 'size': return Array.isArray(value) || typeof value === 'string' ? value.length : UNKNOWN;
            case 'sum': return list.reduce((a, b) => a + b, 0);
            case 'min': return list.length ? Math.min(...list) : null;
            case 'max': return list.length ? Math.max(...list) : null;
        }
        return UNKNOWN;
    }

    private method(expr: ExprData, scope: Scope): Value {
        const args = expr.args ?? [];
        if (expr.member === 'is' && expr.receiver?.name === 'actor' && !expr.receiver.target) {
            if (!scope.actor) return UNKNOWN;
            const target = args[0]?.target;
            const actor = this.nodes.get(scope.actor.actor);
            if (target === scope.actor.actor) return true;
            if (!((actor?.data.roles ?? []) as string[]).includes(target ?? '')) return false;
            const condition = this.nodes.get(target!)?.data.condition as ExprData | undefined;
            return condition ? this.evaluate(condition, { actor: scope.actor }) : true;
        }
        const receiver = this.evaluate(expr.receiver!, scope);
        if (receiver === UNKNOWN) return UNKNOWN;
        if (['map', 'filter', 'exists', 'all'].includes(expr.member!) && Array.isArray(receiver)) {
            const variable = args[0].name!;
            const results = receiver.map(item => this.evaluate(args[1], { ...scope, vars: new Map([...(scope.vars ?? []), [variable, item]]) }));
            if (expr.member === 'map') return results;
            if (expr.member === 'filter') return receiver.filter((_, i) => results[i] === true);
            if (results.includes(UNKNOWN)) return UNKNOWN;
            return expr.member === 'exists' ? results.includes(true) : results.every(r => r === true);
        }
        const arg = args[0] && this.evaluate(args[0], scope);
        if (expr.member === 'size') return Array.isArray(receiver) || typeof receiver === 'string' ? receiver.length : UNKNOWN;
        if (typeof receiver !== 'string' || typeof arg !== 'string') return UNKNOWN;
        switch (expr.member) {
            case 'contains': return receiver.includes(arg);
            case 'startsWith': return receiver.startsWith(arg);
            case 'endsWith': return receiver.endsWith(arg);
            case 'matches': return new RegExp(arg).test(receiver);
        }
        return UNKNOWN;
    }

    private node(qn: string): GraphNode {
        const node = this.nodes.get(qn);
        if (!node) throw new Error(`No element ${qn}.`);
        return node;
    }

    private kids(node: GraphNode, kind?: string): GraphNode[] {
        return (this.children.get(node.qn) ?? []).filter(c => !kind || c.kind === kind);
    }

    private parentOf(qn: string): string {
        return this.graph.edges.find(e => e.kind === 'contains' && e.to === qn)!.from;
    }
}

function isRecord(value: Value | undefined): value is Record {
    return !!value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}

/** A copy of nested records and lists; a record reached twice stays one record. */
function clone(value: Value, copies = new Map<object, Value>()): Value {
    if (!Array.isArray(value) && !isRecord(value)) return value;
    if (copies.has(value)) return copies.get(value)!;
    if (Array.isArray(value)) {
        const list: Value[] = [];
        copies.set(value, list);
        for (const item of value) list.push(clone(item, copies));
        return list;
    }
    const record: Record = {};
    copies.set(value, record);
    for (const [key, field] of Object.entries(value)) record[key] = key === '$type' ? field : clone(field as Value, copies);
    return record;
}

/** Takes a deleted record out of every list that holds it and empties every field that points to it. */
function detach(root: Record, deleted: Record, seen = new Set<object>()): void {
    if (seen.has(root)) return;
    seen.add(root);
    for (const [key, value] of Object.entries(root)) {
        if (value === deleted) root[key] = null;
        else if (Array.isArray(value)) {
            const kept = value.filter(item => item !== deleted);
            if (kept.length !== value.length) root[key] = kept;
            for (const item of kept) if (isRecord(item)) detach(item, deleted, seen);
        } else if (isRecord(value as Value)) detach(value as Record, deleted, seen);
    }
}

function fieldsOf(policy: GraphNode): string[] {
    return (policy.data.fields as string[] | undefined) ?? [];
}

/** A policy without operations covers every operation. */
function covers(policy: GraphNode, operation: string): boolean {
    const operations = (policy.data.operations as string[] | undefined) ?? [];
    return !operations.length || operations.includes(operation);
}

function last(qn: string): string {
    return qn.slice(qn.lastIndexOf('.') + 1);
}

function comparable(value: Value): Value {
    if (value instanceof Date) return value.getTime();
    return typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
}

/** Records compare by identity field `id` when both have one, otherwise by reference; dates by time. */
function equal(a: Value, b: Value): boolean {
    if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b) && !(a instanceof Date) && !(b instanceof Date)) {
        return 'id' in a && 'id' in b ? a.id === b.id : a === b;
    }
    return a === b;
}

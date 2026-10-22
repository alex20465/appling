import type { ExprData, Graph, GraphNode, TypeData } from './graph.js';

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
    violated: string[];
}

const MS: { [unit: string]: number } = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * Evaluates the behavior of a model against sample data and actors, as described in concept.md section 5:
 * which states a machine can reach, which actors may trigger an action, which invariants an action puts at
 * risk, and what running an action on a record does.
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

    /** The shortest sequence of transitions from the machine's initial state to the target state, or undefined. */
    reach(machine: string, state: string): { from: string, path: { transition: string, trigger: string, to: string, guarded: boolean }[] } | undefined {
        const node = this.node(machine);
        const field = this.node(node.data.field as string);
        const initial = (field.data.default as ExprData | undefined)?.name;
        const starts = initial ? [initial] : this.kids(this.node((field.data.type as TypeData).decl!)).map(l => last(l.qn));
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

    /** For every declared actor: whether it may trigger the action, by the action's policies and the entity's update policies. */
    actors(action: string): { actor: string, verdict: Verdict }[] {
        return this.graph.nodes.filter(n => n.kind === 'Actor').map(actor => ({
            actor: actor.qn,
            verdict: this.permitted(action, { actor: actor.qn }, undefined)
        }));
    }

    /** The invariants of the action's entity that read a field the action changes, directly or through derived fields. */
    risks(action: string): { invariant: string, fields: string[] }[] {
        const node = this.node(action);
        const entity = node.data.entity as string | undefined;
        if (!entity) return [];
        const changed = new Set<string>();
        for (const effect of this.kids(node).filter(k => k.kind === 'SetEffect')) changed.add(effect.data.field as string);
        for (const transition of this.graph.nodes.filter(n => n.kind === 'Transition' && n.data.action === action)) {
            changed.add(this.node(this.parentOf(transition.qn)).data.field as string);
            for (const effect of this.kids(transition).filter(k => k.kind === 'SetEffect')) changed.add(effect.data.field as string);
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
        const result: RunResult = { allowed: this.permitted(action, actor, before, inputs), outcome: 'done', reasons: [], before, events: [], violated: [] };
        if (result.allowed === 'no') return { ...result, outcome: 'refused', reasons: ['no policy allows this actor'] };
        const scope = { self: before, actor, inputs };
        const preconditions = (node.data.preconditions ?? []) as { condition: ExprData, error?: string }[];
        preconditions.forEach((precondition, i) => {
            if (this.evaluate(precondition.condition, scope) === false) result.reasons.push(precondition.error ? last(precondition.error) : (node.props.preconditions as string[])[i]);
        });
        if (result.reasons.length) return { ...result, outcome: 'error' };
        const after: Record = { ...before };
        const transitions = this.graph.nodes.filter(n => n.kind === 'Transition' && n.data.action === action);
        if (transitions.length) {
            const field = last(this.node(this.parentOf(transitions[0].qn)).data.field as string);
            const taken = transitions.find(t => (t.data.from as string[]).includes(String(before[field])) && (!t.data.guard || this.evaluate(t.data.guard as ExprData, scope) !== false));
            if (!taken) return { ...result, outcome: 'error', reasons: [`no transition of ${last(this.parentOf(transitions[0].qn))} from ${String(before[field])}`] };
            for (const effect of this.kids(taken)) this.apply(effect, after, scope, result);
            after[field] = taken.data.to as string;
        }
        for (const effect of this.kids(node).filter(k => k.kind.endsWith('Effect'))) this.apply(effect, after, scope, result);
        result.after = after;
        if (entity) {
            for (const invariant of this.kids(this.node(entity), 'Invariant')) {
                if (this.evaluate(invariant.data.condition as ExprData, { self: after, actor, inputs }) === false) result.violated.push(String(invariant.data.label));
            }
        }
        return result;
    }

    /** Evaluates an expression; anything that depends on data that is not given comes back as UNKNOWN. */
    evaluate(expr: ExprData, scope: { self?: Record, actor?: Actor, inputs?: { [name: string]: Value }, vars?: Map<string, Value> }): Value {
        const sub = (e: ExprData) => this.evaluate(e, scope);
        switch (expr.$type) {
            case 'StringExpr': return String(expr.value);
            case 'NumberExpr': return Number(expr.value);
            case 'BoolExpr': return expr.value === true;
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
        const node = this.node(action);
        const entity = node.data.entity as string | undefined;
        const policies = [
            ...this.kids(node, 'Policy'),
            ...(entity ? this.kids(this.node(entity), 'Policy').filter(p => !(p.data.fields as string[] | undefined)?.length && (!(p.data.operations as string[] | undefined)?.length || (p.data.operations as string[]).includes('update'))) : [])
        ];
        const verdicts = policies.map(p => this.evaluate(p.data.condition as ExprData, { self: record, actor, inputs }));
        if (verdicts.some(v => v === false)) return 'no';
        return verdicts.every(v => v === true) ? 'yes' : 'depends';
    }

    private apply(effect: GraphNode, record: Record, scope: { self?: Record, actor?: Actor, inputs?: { [name: string]: Value } }, result: RunResult): void {
        if (effect.kind === 'SetEffect') {
            record[last(effect.data.field as string)] = this.evaluate(effect.data.value as ExprData, { ...scope, self: record });
            return;
        }
        const fields = Object.fromEntries(((effect.data.assignments ?? []) as { name: string, value: ExprData }[]).map(a => [a.name, this.evaluate(a.value, { ...scope, self: record })]));
        if (effect.kind === 'EmitEffect') result.events.push({ event: effect.data.event as string, fields });
    }

    private binary(expr: ExprData, scope: Parameters<Simulator['evaluate']>[1]): Value {
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

    private name(expr: ExprData, scope: Parameters<Simulator['evaluate']>[1]): Value {
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

    private member(receiver: Value, member: string, target: string | undefined, scope: Parameters<Simulator['evaluate']>[1]): Value {
        if (receiver === UNKNOWN || receiver === null || typeof receiver !== 'object' || Array.isArray(receiver) || receiver instanceof Date) return UNKNOWN;
        if (member in receiver) return receiver[member] as Value;
        const field = target ? this.nodes.get(target) : undefined;
        if (field?.data.derived) return this.evaluate(field.data.derived as ExprData, { ...scope, self: receiver, vars: undefined });
        return UNKNOWN;
    }

    private call(expr: ExprData, scope: Parameters<Simulator['evaluate']>[1]): Value {
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

    private method(expr: ExprData, scope: Parameters<Simulator['evaluate']>[1]): Value {
        const args = expr.args ?? [];
        if (expr.member === 'is' && expr.receiver?.name === 'actor' && !expr.receiver.target) {
            if (!scope.actor) return UNKNOWN;
            const target = args[0]?.target;
            const actor = this.nodes.get(scope.actor.actor);
            return target === scope.actor.actor || ((actor?.data.roles ?? []) as string[]).includes(target ?? '');
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

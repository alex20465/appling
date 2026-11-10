import type { MapContext, Step } from '@appling/codegen';
import { Simulator, UNKNOWN, coveredByScenarios, type ExprData, type Graph, type GraphNode, type Record as SimRecord, type TypeData, type Value } from '@appling/model';
import { children, pythonFile, template } from './files.js';
import { userEntity } from './models.js';
import { appOf, constantOf, lastOf, snake } from './python.js';

/** A sample value: its Python code and the value the simulator sees (UNKNOWN when the tests must not rely on it). */
export interface Sample {
    python: string;
    value: Value;
}

/** The record a factory creates, as the simulator sees it, with the steps that write the factory. */
export interface Factory {
    /** The factory function, such as `make_order`, called with keyword overrides. */
    name: string;
    /** The import of the factory for a test or another factory. */
    import: string;
    record: SimRecord;
    steps: Step[];
}

const simulators = new WeakMap<Graph, Simulator>();

/** One simulator per graph, used to prove that a fixture satisfies a guard, a precondition or an invariant. */
export function simulator(context: MapContext): Simulator {
    let found = simulators.get(context.graph);
    if (!found) simulators.set(context.graph, found = new Simulator(context.graph));
    return found;
}

const covers = new WeakMap<Graph, Set<string>>();

/**
 * The actions, use cases and transitions a scenario's `when` runs. Their guessed tests (preconditions,
 * transitions) are not generated: the scenario tests replace them.
 */
export function covered(context: MapContext): Set<string> {
    let found = covers.get(context.graph);
    if (!found) covers.set(context.graph, found = coveredByScenarios(context.graph));
    return found;
}

/** Whether an expression is true for the given record and inputs; UNKNOWN counts as not proven. */
export function holds(expr: ExprData, context: MapContext, self: SimRecord | undefined, inputs: { [name: string]: Value } = {}): boolean {
    return simulator(context).evaluate(expr, { self, inputs }) === true;
}

/**
 * A factory in `<app>/factories.py` that creates a valid row of the entity: a value for every required stored
 * field without a default, related rows through their own factories. Undefined when the model does not say
 * enough, such as a required file, a cycle of required relations, or an invariant the sample row breaks.
 */
export function factory(entity: GraphNode, context: MapContext, seen: Set<string> = new Set()): Factory | undefined {
    if (seen.has(entity.qn)) return undefined;
    const app = appOf(entity.module);
    const name = `make_${snake(lastOf(entity.qn))}`;
    const imports = new Set([`from ${app}.models import ${lastOf(entity.qn)}`]);
    const record: SimRecord = { $type: entity.qn };
    const values: [string, string][] = [];
    const steps: Step[] = [];
    let sequence = false;
    for (const field of children(entity, context, 'Field')) {
        const type = field.data.type as TypeData;
        const fieldName = lastOf(field.qn);
        if (field.data.derived) continue;
        if (type.many) {
            record[fieldName] = [];
            continue;
        }
        if (field.data.default) {
            record[fieldName] = simulator(context).evaluate(field.data.default as ExprData, { self: record });
            continue;
        }
        if (type.optional) {
            record[fieldName] = null;
            continue;
        }
        const unique = ((field.data.modifiers ?? []) as string[]).includes('unique');
        const decl = type.decl ? context.node(type.decl) : undefined;
        let value: Sample | undefined;
        if (decl?.kind === 'Entity') {
            const related = factory(decl, context, new Set([...seen, entity.qn]));
            if (!related) return undefined;
            steps.push(...related.steps);
            if (appOf(decl.module) !== app) imports.add(related.import);
            value = { python: `${related.name}()`, value: related.record };
        } else {
            value = sample(fieldName, type, unique, context, imports);
            if (value?.python.includes('next(_sequence)')) sequence = true;
        }
        if (!value) return undefined;
        values.push([fieldName, value.python]);
        record[fieldName] = value.value;
    }
    if (userEntity(context) === entity.qn && !values.some(([n]) => n === 'username')) {
        values.unshift(['username', 'f"user-{next(_sequence)}"']);
        sequence = true;
    }
    if (children(entity, context, 'Invariant').some(i => !holds(i.data.condition as ExprData, context, record))) return undefined;
    if (sequence) imports.add('from itertools import count');
    const code = [
        `def ${name}(**fields):`,
        `    """${/^[AEIOU]/.test(lastOf(entity.qn)) ? 'An' : 'A'} ${lastOf(entity.qn)} with a value for every required field; the fields given replace them."""`,
        `    values = {${values.map(([n, v]) => `${JSON.stringify(n)}: ${v}`).join(', ')}}`,
        '    values.update(fields)',
        `    return ${lastOf(entity.qn)}.objects.create(**values)`
    ].join('\n');
    steps.push(template(`${app}/factories.py`, existing => {
        if (existing?.includes(`\ndef ${name}(`) || existing?.startsWith(`def ${name}(`)) return existing;
        const counter = sequence && !existing?.includes('_sequence = count(1)') ? '_sequence = count(1)\n\n\n' : '';
        return pythonFile(existing, imports, counter + code);
    }));
    return { name, import: `from ${app}.factories import ${name}`, record, steps };
}

/** A sample value of a required field or input without a default; undefined when there is none, such as for a file. */
export function sample(name: string, type: TypeData, unique: boolean, context: MapContext, imports: Set<string>): Sample | undefined {
    if (type.decl) {
        const decl = context.node(type.decl)!;
        if (decl.kind === 'Enum') {
            const first = context.children(decl.qn)[0];
            if (!first || unique) return undefined;
            imports.add(`from ${appOf(decl.module)}.enums import ${lastOf(decl.qn)}`);
            return { python: `${lastOf(decl.qn)}.${constantOf(lastOf(first.qn))}`, value: lastOf(first.qn) };
        }
        return undefined;
    }
    switch (type.primitive) {
        case 'String':
        case 'Text': return { python: `f"${name}-{next(_sequence)}"`, value: UNKNOWN };
        case 'Int': return unique ? { python: 'next(_sequence)', value: UNKNOWN } : { python: '1', value: 1 };
        case 'Decimal':
        case 'Money':
            imports.add('from decimal import Decimal');
            return unique ? { python: 'Decimal(next(_sequence))', value: UNKNOWN } : { python: 'Decimal("1")', value: 1 };
        case 'Bool': return unique ? undefined : { python: 'False', value: false };
        case 'Date':
            imports.add('from datetime import date');
            return unique ? undefined : { python: 'date.today()', value: UNKNOWN };
        case 'DateTime':
            imports.add('from django.utils import timezone');
            return unique ? undefined : { python: 'timezone.now()', value: UNKNOWN };
        case 'Duration':
            imports.add('from datetime import timedelta');
            return unique ? undefined : { python: 'timedelta(hours=1)', value: 3_600_000 };
        case 'Uuid':
            imports.add('from uuid import uuid4');
            return { python: 'uuid4()', value: UNKNOWN };
    }
    return undefined;
}

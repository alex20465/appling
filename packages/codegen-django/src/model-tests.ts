import type { MapContext, Step } from '@appling/codegen';
import type { ExprData, GraphNode, Record as SimRecord, TypeData, Value } from '@appling/model';
import { children } from './files.js';
import { factory, holds, simulator } from './fixtures.js';
import { appOf, constantOf, lastOf, parentOf, snake } from './python.js';
import { testSteps, type TestCase } from './tests.js';

/** A value a test may set on a field, as Python and as the simulator sees it. */
interface Candidate {
    python: string;
    value: Value;
}

/**
 * The tests of an invariant enforced as a `CheckConstraint`: the entity's factory row is stored, and a row
 * whose one field the simulator proves to break this invariant (and no other) raises `IntegrityError`.
 * Without a factory or a translated constraint, or without such a field value, a case stays a registry task.
 */
export function invariantTests(invariant: GraphNode, enforced: boolean, context: MapContext): Step[] {
    const cases = ['holds_for_valid_rows', 'rejects_violations'];
    const rule = String(invariant.props.condition);
    const entity = context.node(parentOf(invariant.qn))!;
    const made = enforced ? factory(entity, context) : undefined;
    if (!made) return testSteps(invariant, rule, cases, context);
    const model = lastOf(entity.qn);
    const instance = snake(model);
    const imports = new Set([made.import, `from ${appOf(entity.module)}.models import ${model}`]);
    const violation = violating(invariant, entity, made.record, context, imports);
    if (violation) imports.add('from django.db import IntegrityError, transaction');
    const tests: TestCase[] = [
        { name: cases[0], body: [`${instance} = ${made.name}()`, `self.assertTrue(${model}.objects.filter(pk=${instance}.pk).exists())`] },
        { name: cases[1], body: violation === undefined ? undefined : ['with self.assertRaises(IntegrityError), transaction.atomic():', `    ${made.name}(${violation})`] }
    ];
    return testSteps(invariant, rule, tests, context, imports, made.steps);
}

/**
 * A keyword override such as `total=Decimal("-1")` for which the invariant is false and every other invariant
 * of the entity true. Every field the condition reads must stay non null, since SQL lets a check on NULL pass.
 */
function violating(invariant: GraphNode, entity: GraphNode, record: SimRecord, context: MapContext, imports: Set<string>): string | undefined {
    const condition = invariant.data.condition as ExprData;
    const read = targets(condition);
    const fields = children(entity, context, 'Field').filter(f => read.has(f.qn) && !f.data.derived && !(f.data.type as TypeData).many);
    const others = children(entity, context, 'Invariant').filter(i => i.qn !== invariant.qn);
    for (const field of fields) {
        const name = lastOf(field.qn);
        for (const candidate of candidates(field.data.type as TypeData, context)) {
            const row = { ...record, [name]: candidate.value };
            if (fields.some(f => row[lastOf(f.qn)] === null || row[lastOf(f.qn)] === undefined)) continue;
            if (simulator(context).evaluate(condition, { self: row }) !== false) continue;
            if (!others.every(i => holds(i.data.condition as ExprData, context, row))) continue;
            const decl = (field.data.type as TypeData).decl;
            if (decl) imports.add(`from ${appOf(context.node(decl)!.module)}.enums import ${lastOf(decl)}`);
            if (candidate.python.startsWith('Decimal(')) imports.add('from decimal import Decimal');
            return `${name}=${candidate.python}`;
        }
    }
    return undefined;
}

/** The values tried on a field: a few numbers, both booleans, every enum literal; none for other types. */
function candidates(type: TypeData, context: MapContext): Candidate[] {
    if (type.decl) {
        const decl = context.node(type.decl);
        if (decl?.kind !== 'Enum') return [];
        return context.children(decl.qn).map(l => ({ python: `${lastOf(decl.qn)}.${constantOf(lastOf(l.qn))}`, value: lastOf(l.qn) }));
    }
    const numbers = [-1, 0, 1_000_000];
    switch (type.primitive) {
        case 'Int': return numbers.map(n => ({ python: String(n), value: n }));
        case 'Decimal':
        case 'Money': return numbers.map(n => ({ python: `Decimal("${n}")`, value: n }));
        case 'Bool': return [{ python: 'True', value: true }, { python: 'False', value: false }];
    }
    return [];
}

/** The qualified names the expression compares; a name only tested by `has()` is left out, its null is meant. */
function targets(expr: unknown, found: Set<string> = new Set()): Set<string> {
    if (Array.isArray(expr)) {
        for (const item of expr) targets(item, found);
    } else if (expr && typeof expr === 'object') {
        const node = expr as { $type?: string, target?: unknown, call?: unknown, name?: unknown };
        if (node.$type === 'NameExpr' && node.call && node.name === 'has') return found;
        if (node.$type === 'NameExpr' && typeof node.target === 'string') found.add(node.target);
        for (const value of Object.values(expr)) targets(value, found);
    }
    return found;
}

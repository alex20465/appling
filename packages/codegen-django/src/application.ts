import type { MapContext, Step } from '@appling/codegen';
import type { ExprData, GraphNode, TypeData } from '@appling/model';
import { annotation, children, docstring, pythonFile, task, template } from './files.js';
import { enforced, fieldGuards, policyImport, queryGuard, useCaseGuard } from './access.js';
import { scope, storedFields } from './models.js';
import { appOf, lastOf, parentOf, python, q, snake, type PythonScope } from './python.js';

/** The code of a query function, or undefined when its filter cannot be translated. */
export function queryCode(query: GraphNode, context: MapContext, imports: Set<string>): string | undefined {
    const entity = context.node(query.data.entity as string)!;
    const filter = query.data.filter ? q(query.data.filter as ExprData, storedFields(entity, context), context.node, scope(context, imports)) : undefined;
    if (query.data.filter && !filter) return undefined;
    const sorts = ((query.data.sorts ?? []) as { field: string, direction?: string }[]).map(s => JSON.stringify(`${s.direction === 'desc' ? '-' : ''}${lastOf(s.field)}`));
    imports.add(`from ${appOf(entity.module)}.models import ${lastOf(entity.qn)}`);
    if (filter) imports.add('from django.db import models');
    const rows = `${lastOf(entity.qn)}.objects${filter ? `.filter(${filter})` : '.all()'}${sorts.length ? `.order_by(${sorts.join(', ')})` : ''}`;
    const guard = queryGuard(query, context, imports);
    const body = guard.length ? [`rows = ${rows}`, ...guard, ...(guard.at(-1) === 'return rows.none()' ? [] : ['return rows'])] : [`return ${rows}`];
    return [
        ...(query.data.pageSize ? [`${pageSizeName(query)} = ${query.data.pageSize}`, '', ''] : []),
        `def ${snake(lastOf(query.qn))}(${guard.length ? 'actor=None' : ''}):`,
        ...docstring(query, '    '),
        ...body.map(l => `    ${l}`)
    ].join('\n');
}

/** A call of a query function, passing the actor when the query checks policies. */
export function queryCall(query: GraphNode, actor: string, context: MapContext): string {
    return `${snake(lastOf(query.qn))}(${enforced(context) ? `actor=${actor}` : ''})`;
}

export function pageSizeName(query: GraphNode): string {
    return `${snake(lastOf(query.qn)).toUpperCase()}_PAGE_SIZE`;
}

export function querySteps(query: GraphNode, context: MapContext): Step[] {
    const imports = new Set<string>();
    const code = queryCode(query, context, imports);
    if (!code) return [task(`implement the query ${lastOf(query.qn)} where ${query.props.filter}`)];
    return [template(`${appOf(query.module)}/queries.py`, existing => pythonFile(existing, imports, code))];
}

/** A projection becomes a REST framework model serializer; computed fields that follow references become `source` paths. */
export function projectionSteps(projection: GraphNode, context: MapContext): Step[] {
    const source = context.node(projection.data.source as string)!;
    const entity = source.kind === 'Query' ? context.node(source.data.entity as string)! : source;
    const derived = new Set(children(entity, context, 'Field').filter(f => f.data.derived).map(f => lastOf(f.qn)));
    const imports = new Set(['from rest_framework import serializers', `from ${appOf(entity.module)}.models import ${lastOf(entity.qn)}`]);
    const declared: string[] = [];
    const fields: string[] = [];
    const hidden: string[] = [];
    const guards = fieldGuards(entity, context);
    for (const field of children(projection, context, 'ProjectionField')) {
        const name = lastOf(field.qn);
        if (field.data.value) {
            const path = sourcePath(field.data.value as ExprData, context);
            if (!path) continue;
            declared.push(`    ${name} = serializers.ReadOnlyField(source=${JSON.stringify(path)})`);
        } else if (derived.has(name)) {
            declared.push(`    ${name} = serializers.ReadOnlyField()`);
        }
        fields.push(JSON.stringify(name));
        const path = field.data.value ? sourcePath(field.data.value as ExprData, context) : name;
        const guard = path && guards.get(path.split('.')[0]);
        if (guard) hidden.push(`        if ${JSON.stringify(name)} in data and not ${policyImport(entity, guard, imports)}(actor, instance):`, `            data[${JSON.stringify(name)}] = None`);
    }
    const code = [
        `class ${lastOf(projection.qn)}(serializers.ModelSerializer):`,
        ...docstring(projection, '    '),
        ...declared,
        ...(declared.length ? [''] : []),
        '    class Meta:',
        `        model = ${lastOf(entity.qn)}`,
        `        fields = [${fields.join(', ')}]`,
        ...(hidden.length ? [
            '',
            '    def to_representation(self, instance):',
            '        """Hides the fields the requesting actor may not read; without a request nothing is hidden."""',
            '        data = super().to_representation(instance)',
            '        actor = getattr(self.context.get("request"), "user", None)',
            '        if actor is None:',
            '            return data',
            ...hidden,
            '        return data'
        ] : [])
    ].join('\n');
    return [template(`${appOf(projection.module)}/serializers.py`, existing => pythonFile(existing, imports, code))];
}

export function projectionFieldSteps(field: GraphNode, context: MapContext): Step[] {
    return field.data.value && !sourcePath(field.data.value as ExprData, context) ? [task(`add the computed field ${lastOf(field.qn)} = ${field.props.value} to the serializer`)] : [];
}

/** `customer.name` over entity fields, as a dotted serializer source; undefined for anything else. */
export function sourcePath(expr: ExprData, context: MapContext): string | undefined {
    const isEntityField = (qn?: string) => qn !== undefined && context.node(qn)?.kind === 'Field' && context.node(parentOf(qn))?.kind === 'Entity';
    if (expr.$type === 'NameExpr' && !expr.call && isEntityField(expr.target)) return expr.name;
    if (expr.$type === 'MemberExpr' && !expr.call && isEntityField(expr.target)) {
        const receiver = sourcePath(expr.receiver!, context);
        return receiver && `${receiver}.${expr.member}`;
    }
    return undefined;
}

/** An external system becomes a typing Protocol the application depends on; the client itself is a task. */
export function externalSteps(external: GraphNode, context: MapContext): Step[] {
    const imports = new Set(['from typing import Protocol']);
    const methods = children(external, context, 'ExternalOperation').flatMap(op => {
        const params = children(op, context, 'Param').map(p => `${lastOf(p.qn)}: ${annotation(p.data.type as TypeData, context, imports)}`);
        const returns = op.data.returns ? annotation(op.data.returns as TypeData, context, imports) : 'None';
        return ['', `    def ${snake(lastOf(op.qn))}(self, ${params.join(', ')}) -> ${returns}:`, ...docstring(op, '        '), '        ...'];
    });
    const code = [`class ${lastOf(external.qn)}(Protocol):`, ...docstring(external, '    '), ...(methods.length ? methods.slice(1) : ['    pass'])].join('\n');
    return [
        template(`${appOf(external.module)}/externals.py`, existing => pythonFile(existing, imports, code)),
        task(`implement a client for ${lastOf(external.qn)} and pass it to the use cases that call it`)
    ];
}

interface Call {
    target: string;
    /** Left out by the graph when the call has no arguments. */
    args?: ExprData[];
}

/** A use case becomes a function that calls its steps in order and handles the declared errors. */
export function useCaseSteps(useCase: GraphNode, context: MapContext): Step[] {
    const { imports, code, tasks } = useCaseCode(useCase, context);
    return [template(`${appOf(useCase.module)}/usecases.py`, existing => pythonFile(existing, imports, code)), ...tasks];
}

/** The externals a use case function takes as keyword arguments, named `snake(external)`, in signature order. */
export function useCaseExternals(useCase: GraphNode, context: MapContext): GraphNode[] {
    return useCaseCode(useCase, context).externals;
}

function useCaseCode(useCase: GraphNode, context: MapContext): { imports: Set<string>, code: string, tasks: Step[], externals: GraphNode[] } {
    const imports = new Set<string>();
    const tasks: Step[] = [];
    const params = children(useCase, context, 'Param');
    const pyScope: PythonScope = { ...scope(context, imports), actor: 'actor' };
    const externals = new Set<GraphNode>();
    const lines: string[] = [];
    for (const step of (useCase.data.steps ?? []) as { $type: string, call?: Call, handlers?: { error: string, call: Call }[], event?: string, timeout?: string }[]) {
        if (step.$type === 'AwaitStep') {
            tasks.push(task(`continue ${lastOf(useCase.qn)} when ${lastOf(step.event!)} happens${step.timeout ? `, or after ${step.timeout} with the timeout call` : ''}; the steps from here on are not generated`));
            break;
        }
        const call = callCode(step.call!, context, pyScope, externals);
        if (!call) {
            tasks.push(task(`call ${lastOf(step.call!.target)} in ${lastOf(useCase.qn)}; the steps from here on are not generated`));
            break;
        }
        if (!step.handlers?.length) {
            lines.push(call);
            continue;
        }
        lines.push('try:', `    ${call}`);
        for (const handler of step.handlers) {
            const recovery = callCode(handler.call, context, pyScope, externals);
            const error = context.node(handler.error)!;
            imports.add(`from ${appOf(error.module)}.errors import ${lastOf(error.qn)}`);
            lines.push(`except ${lastOf(error.qn)}:`, `    ${recovery ?? 'raise'}`);
            if (!recovery) tasks.push(task(`recover from ${lastOf(error.qn)} with ${lastOf(handler.call.target)} in ${lastOf(useCase.qn)}`));
        }
    }
    const signature = [
        ...params.map(p => `${lastOf(p.qn)}: ${annotation(p.data.type as TypeData, context, imports)}`),
        '*',
        'actor=None',
        ...[...externals].map(e => {
            imports.add(`from ${appOf(e.module)}.externals import ${lastOf(e.qn)}`);
            return `${snake(lastOf(e.qn))}: ${lastOf(e.qn)}`;
        })
    ];
    lines.unshift(...useCaseGuard(useCase, context, pyScope));
    const code = [`def ${snake(lastOf(useCase.qn))}(${signature.join(', ')}) -> None:`, ...docstring(useCase, '    '), ...(lines.length ? lines : ['pass']).map(l => `    ${l}`)].join('\n');
    return { imports, code, tasks, externals: [...externals] };
}

function callCode(call: Call, context: MapContext, pyScope: PythonScope, externals: Set<GraphNode>): string | undefined {
    const target = context.node(call.target)!;
    const args = (call.args ?? []).map(a => python(a, pyScope));
    if (args.some(a => a === undefined)) return undefined;
    const name = snake(lastOf(target.qn));
    if (target.kind === 'Action') {
        pyScope.imports.add(`from ${appOf(target.module)}.actions import ${name}`);
        const inputs = children(target, context, 'Param').map(p => lastOf(p.qn));
        const positional = target.data.entity ? args.slice(0, 1) : [];
        const named = args.slice(positional.length).map((a, i) => `${inputs[i]}=${a}`);
        return `${name}(${[...positional, ...named, 'actor=actor'].join(', ')})`;
    }
    if (target.kind === 'ExternalOperation') {
        const external = context.node(parentOf(target.qn))!;
        externals.add(external);
        return `${snake(lastOf(external.qn))}.${name}(${args.join(', ')})`;
    }
    if (target.kind === 'Query') {
        pyScope.imports.add(`from ${appOf(target.module)}.queries import ${name}`);
        return queryCall(target, 'actor', context);
    }
    return undefined;
}

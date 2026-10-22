import type { MapContext, Step } from '@appling/codegen';
import type { ExprData, GraphNode, TypeData } from '@appling/model';
import { annotation, children, pythonFile, task, template } from './files.js';
import { testSteps } from './tests.js';
import { appOf, constantOf, lastOf, parentOf, python, q, type PythonScope } from './python.js';

const PRIMITIVES: Record<string, string> = {
    String: 'models.CharField(max_length=255',
    Text: 'models.TextField(',
    Int: 'models.IntegerField(',
    Decimal: 'models.DecimalField(max_digits=19, decimal_places=4',
    Money: 'models.DecimalField(max_digits=19, decimal_places=2',
    Bool: 'models.BooleanField(',
    Date: 'models.DateField(',
    DateTime: 'models.DateTimeField(',
    Duration: 'models.DurationField(',
    File: 'models.FileField(',
    Uuid: 'models.UUIDField('
};

export function moduleSteps(node: GraphNode): Step[] {
    const app = appOf(node.qn);
    return [
        { kind: 'command', run: ['uv', 'run', 'python', 'manage.py', 'startapp', app], creates: [`${app}/`] },
        installApp(app)
    ];
}

export function installApp(app: string): Step {
    return template('config/settings.py', existing => existing!.replace(/INSTALLED_APPS = \[\n([\s\S]*?)\]/, (_, apps) => `INSTALLED_APPS = [\n${apps}    '${app}',\n]`));
}

export function enumSteps(node: GraphNode, context: MapContext): Step[] {
    const literals = children(node, context).map(l => lastOf(l.qn));
    const code = [`class ${lastOf(node.qn)}(models.TextChoices):`, ...literals.map(l => `    ${constantOf(l)} = ${JSON.stringify(l)}`)].join('\n');
    return [template(`${appOf(node.module)}/enums.py`, existing => pythonFile(existing, ['from django.db import models'], code))];
}

export function valueSteps(node: GraphNode, context: MapContext): Step[] {
    const imports = new Set(['from typing import TypedDict']);
    const lines = children(node, context, 'Field').filter(f => !f.data.derived).map(f => `    ${lastOf(f.qn)}: ${annotation(f.data.type as TypeData, context, imports)}`);
    const code = [`class ${lastOf(node.qn)}(TypedDict):`, ...(lines.length ? lines : ['    pass'])].join('\n');
    return [template(`${appOf(node.module)}/values.py`, existing => pythonFile(existing, imports, code))];
}

export function entitySteps(entity: GraphNode, context: MapContext): Step[] {
    const imports = new Set(['from django.db import models']);
    const code = modelClass(entity, context, imports);
    return [template(`${appOf(entity.module)}/models.py`, existing => pythonFile(existing, imports, code))];
}

export function fieldSteps(field: GraphNode, context: MapContext): Step[] | undefined {
    const owner = context.node(parentOf(field.qn))!.kind;
    if (owner === 'Event') return [];
    if (owner !== 'Entity' && owner !== 'ValueType') return undefined;
    const tasks: Step[] = [];
    if (field.data.derived && (owner === 'ValueType' || !property(field, context, new Set()))) {
        tasks.push(task(`implement the derived field ${lastOf(field.qn)} = ${field.props.derived}`));
    }
    if (field.data.default && (owner === 'ValueType' || defaultValue(field, context, new Set()) === undefined)) {
        tasks.push(task(`set the default of ${lastOf(field.qn)} to ${field.props.default}`));
    }
    return tasks;
}

export function invariantSteps(invariant: GraphNode, context: MapContext): Step[] {
    const rule = constraint(invariant, context) ? [] : [task(`enforce the invariant "${invariant.data.label}": ${invariant.props.condition}`)];
    return [...rule, ...testSteps(invariant, String(invariant.props.condition), ['holds_for_valid_rows', 'rejects_violations'], context)];
}

export function policySteps(policy: GraphNode, context: MapContext): Step[] {
    const operations = (policy.data.operations ?? []) as string[];
    const fields = ((policy.data.fields ?? []) as string[]).map(lastOf);
    const scope = `${operations.length ? operations.join(', ') : 'any'}${fields.length ? ` (fields ${fields.join(', ')})` : ''}`;
    return [
        task(`enforce the ${scope} policy of ${parentOf(policy.qn)}: ${policy.props.condition}`),
        ...testSteps(policy, String(policy.props.condition), ['allows_permitted_actors', 'denies_other_actors'], context)
    ];
}

function modelClass(entity: GraphNode, context: MapContext, imports: Set<string>): string {
    const name = lastOf(entity.qn);
    const fields = children(entity, context, 'Field');
    const lines: string[] = [];
    for (const field of fields.filter(f => !f.data.derived)) lines.push(`    ${lastOf(field.qn)} = ${djangoField(field, context, imports)}`);
    for (const field of fields.filter(f => f.data.derived)) {
        const code = property(field, context, imports);
        if (code) lines.push('', '    @property', `    def ${lastOf(field.qn)}(self):`, `        return ${code}`);
    }
    const constraints = children(entity, context, 'Invariant').flatMap(invariant => {
        const condition = constraint(invariant, context);
        const id = `${appOf(entity.module)}_${name}_${String(invariant.data.label)}`.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
        return condition ? [`            models.CheckConstraint(condition=${condition}, name=${JSON.stringify(id)}),`] : [];
    });
    if (constraints.length) lines.push('', '    class Meta:', '        constraints = [', ...constraints, '        ]');
    return [`class ${name}(models.Model):`, ...(lines.length ? lines : ['    pass'])].join('\n');
}

export function djangoField(field: GraphNode, context: MapContext, imports: Set<string>): string {
    const type = field.data.type as TypeData;
    const modifiers = (field.data.modifiers ?? []) as string[];
    const options: string[] = [];
    if (type.optional) options.push('null=True', 'blank=True');
    if (modifiers.includes('unique')) options.push('unique=True');
    const fallback = defaultValue(field, context, imports);
    if (fallback !== undefined) options.push(`default=${fallback}`);
    const decl = type.decl ? context.node(type.decl) : undefined;
    const call = (start: string) => `${start}${start.endsWith('(') || !options.length ? '' : ', '}${options.join(', ')})`;
    if (type.many && decl?.kind === 'Entity') return `models.ManyToManyField(${JSON.stringify(modelLabel(decl))})`;
    if (type.many || decl?.kind === 'ValueType') {
        if (fallback === undefined) options.push(`default=${type.many ? 'list' : 'dict'}`);
        imports.add('from django.core.serializers.json import DjangoJSONEncoder');
        return call('models.JSONField(encoder=DjangoJSONEncoder');
    }
    if (decl?.kind === 'Entity') {
        const onDelete = modifiers.includes('owned') ? 'models.CASCADE' : 'models.PROTECT';
        return call(`models.ForeignKey(${JSON.stringify(modelLabel(decl))}, on_delete=${onDelete}`);
    }
    if (decl?.kind === 'Enum') {
        imports.add(`from ${appOf(decl.module)}.enums import ${lastOf(decl.qn)}`);
        const longest = Math.max(...context.children(decl.qn).map(l => lastOf(l.qn).length));
        return call(`models.CharField(max_length=${Math.max(longest, 32)}, choices=${lastOf(decl.qn)}.choices`);
    }
    if (type.primitive === 'File') return call(`models.FileField(upload_to=${JSON.stringify(`${appOf(field.module)}/${lastOf(parentOf(field.qn)).toLowerCase()}/`)}`);
    return call(PRIMITIVES[type.primitive!]);
}

function defaultValue(field: GraphNode, context: MapContext, imports: Set<string>): string | undefined {
    const expr = field.data.default as ExprData | undefined;
    if (!expr) return undefined;
    if (expr.$type === 'NameExpr' && expr.name === 'now' && !expr.target) {
        imports.add('from django.utils import timezone');
        return 'timezone.now';
    }
    return python(expr, scope(context, imports));
}

function property(field: GraphNode, context: MapContext, imports: Set<string>): string | undefined {
    return python(field.data.derived as ExprData, { ...scope(context, imports), self: 'self' });
}

function constraint(invariant: GraphNode, context: MapContext): string | undefined {
    return q(invariant.data.condition as ExprData, storedFields(context.node(parentOf(invariant.qn))!, context), context.node);
}

/** The fields of an entity that are database columns. */
export function storedFields(entity: GraphNode, context: MapContext): Set<string> {
    return new Set(children(entity, context, 'Field').filter(f => !f.data.derived && !(f.data.type as TypeData).many).map(f => f.qn));
}

export function scope(context: MapContext, imports: Set<string>): PythonScope {
    return { node: context.node, imports };
}

export function modelLabel(entity: GraphNode): string {
    return `${appOf(entity.module)}.${lastOf(entity.qn)}`;
}

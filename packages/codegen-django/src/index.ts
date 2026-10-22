import type { CodegenExtension, MapContext, Step } from '@appling/codegen';
import type { ExprData, GraphNode, TypeData } from '@appling/model';
import { appOf, constantOf, lastOf, parentOf, python, q, type PythonScope } from './python.js';

const DJANGO = 'django~=6.1.0';

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

const PYTHON_TYPES: Record<string, string> = {
    String: 'str', Text: 'str', Int: 'int', Decimal: 'Decimal', Money: 'Decimal', Bool: 'bool', Date: 'date',
    DateTime: 'datetime', Duration: 'timedelta', File: 'str', Uuid: 'UUID'
};

const extension: CodegenExtension = {
    name: '@appling/codegen-django',
    prerequisites: [{ name: 'uv', command: ['uv', '--version'], expect: /^uv \d+\.\d+/, hint: 'install uv (https://docs.astral.sh/uv/) to manage the Python project' }],

    setup: context => [
        { kind: 'command', run: ['uv', 'init', '--bare', '--name', context.name], creates: ['pyproject.toml'] },
        { kind: 'command', run: ['uv', 'add', DJANGO], creates: ['uv.lock'] },
        { kind: 'command', run: ['uv', 'run', 'django-admin', 'startproject', 'config', '.'], creates: ['manage.py', 'config/'] }
    ],

    steps(node, context) {
        switch (node.kind) {
            case 'Module': return moduleSteps(node);
            case 'Enum': return [template(`${appOf(node.module)}/enums.py`, existing => append(existing ?? 'from django.db import models\n', enumClass(node, context)))];
            case 'ValueType': return [template(`${appOf(node.module)}/values.py`, existing => append(existing ?? valuesHeader(), valueClass(node, context)))];
            case 'Entity': return [template(`${appOf(node.module)}/models.py`, existing => modelsFile(existing, node, context))];
            case 'EnumLiteral': return [];
            case 'Field': return fieldSteps(node, context);
            case 'Invariant': return constraint(node, context) ? [] : [task(`enforce the invariant "${node.data.label}": ${node.props.condition}`)];
            case 'Policy': return node.layer === 'domain' ? [task(`enforce the ${policyScope(node)} policy: ${node.props.condition}`)] : undefined;
            default: return undefined;
        }
    }
};

export default extension;

function moduleSteps(node: GraphNode): Step[] {
    const app = appOf(node.qn);
    return [
        { kind: 'command', run: ['uv', 'run', 'python', 'manage.py', 'startapp', app], creates: [`${app}/`] },
        template('config/settings.py', existing => existing!.replace(/INSTALLED_APPS = \[\n([\s\S]*?)\]/, (_, apps) => `INSTALLED_APPS = [\n${apps}    '${app}',\n]`))
    ];
}

function fieldSteps(field: GraphNode, context: MapContext): Step[] | undefined {
    const owner = context.node(parentOf(field.qn))!.kind;
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

function enumClass(node: GraphNode, context: MapContext): string {
    const literals = context.children(node.qn).map(l => lastOf(l.qn));
    return [`class ${lastOf(node.qn)}(models.TextChoices):`, ...literals.map(l => `    ${constantOf(l)} = ${JSON.stringify(l)}`)].join('\n');
}

function valuesHeader(): string {
    return 'from datetime import date, datetime, timedelta\nfrom decimal import Decimal\nfrom typing import TypedDict\nfrom uuid import UUID\n';
}

function valueClass(node: GraphNode, context: MapContext): string {
    const fields = context.children(node.qn).filter(f => f.kind === 'Field' && !f.data.derived);
    const lines = fields.map(f => `    ${lastOf(f.qn)}: ${pythonType(f.data.type as TypeData)}`);
    return [`class ${lastOf(node.qn)}(TypedDict):`, ...(lines.length ? lines : ['    pass'])].join('\n');
}

function pythonType(type: TypeData): string {
    const base = type.primitive ? PYTHON_TYPES[type.primitive] : type.decl ? 'dict' : 'object';
    const many = type.many ? `list[${base}]` : base;
    return type.optional ? `${many} | None` : many;
}

function modelsFile(existing: string | undefined, entity: GraphNode, context: MapContext): string {
    const imports = new Set<string>();
    const body = modelClass(entity, context, imports);
    let text = (existing ?? 'from django.db import models\n').replace('\n# Create your models here.\n', '');
    for (const line of [...imports].sort()) {
        if (!text.includes(`${line}\n`)) text = text.replace('from django.db import models\n', `from django.db import models\n${line}\n`);
    }
    return append(text, body);
}

function modelClass(entity: GraphNode, context: MapContext, imports: Set<string>): string {
    const name = lastOf(entity.qn);
    const fields = context.children(entity.qn).filter(f => f.kind === 'Field');
    const lines: string[] = [];
    for (const field of fields.filter(f => !f.data.derived)) lines.push(`    ${lastOf(field.qn)} = ${djangoField(field, context, imports)}`);
    for (const field of fields.filter(f => f.data.derived)) {
        const code = property(field, context, imports);
        if (code) lines.push('', '    @property', `    def ${lastOf(field.qn)}(self):`, `        return ${code}`);
    }
    const constraints = context.children(entity.qn).filter(n => n.kind === 'Invariant').flatMap(invariant => {
        const condition = constraint(invariant, context);
        const id = `${appOf(entity.module)}_${name}_${String(invariant.data.label)}`.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
        return condition ? [`            models.CheckConstraint(condition=${condition}, name=${JSON.stringify(id)}),`] : [];
    });
    if (constraints.length) lines.push('', '    class Meta:', '        constraints = [', ...constraints, '        ]');
    return [`class ${name}(models.Model):`, ...(lines.length ? lines : ['    pass'])].join('\n');
}

function djangoField(field: GraphNode, context: MapContext, imports: Set<string>): string {
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
        return call('models.JSONField(');
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
    const entity = parentOf(invariant.qn);
    const stored = new Set(context.children(entity).filter(f => f.kind === 'Field' && !f.data.derived && !(f.data.type as TypeData).many).map(f => f.qn));
    return q(invariant.data.condition as ExprData, stored, context.node);
}

function scope(context: MapContext, imports: Set<string>): PythonScope {
    return { node: context.node, imports };
}

function modelLabel(entity: GraphNode): string {
    return `${appOf(entity.module)}.${lastOf(entity.qn)}`;
}

function policyScope(policy: GraphNode): string {
    const operations = (policy.data.operations ?? []) as string[];
    const fields = ((policy.data.fields ?? []) as string[]).map(lastOf);
    return `${operations.length ? operations.join(', ') : 'any'}${fields.length ? ` (fields ${fields.join(', ')})` : ''}`;
}

function template(file: string, write: (existing: string | undefined) => string): Step {
    return { kind: 'template', file, write };
}

function task(what: string): Step {
    return { kind: 'task', what };
}

function append(text: string, block: string): string {
    return `${text.trimEnd()}\n\n\n${block}\n`;
}

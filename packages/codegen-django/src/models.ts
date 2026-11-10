import type { MapContext, Step } from '@appling/codegen';
import type { ExprData, GraphNode, TypeData } from '@appling/model';
import { annotation, children, documented, pythonFile, task, template } from './files.js';
import { invariantTests } from './model-tests.js';
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
    const code = documented([`class ${lastOf(node.qn)}(models.TextChoices):`, ...literals.map(l => `    ${constantOf(l)} = ${JSON.stringify(l)}`)].join('\n'), node);
    return [template(`${appOf(node.module)}/enums.py`, existing => pythonFile(existing, ['from django.db import models'], code))];
}

export function valueSteps(node: GraphNode, context: MapContext): Step[] {
    const imports = new Set(['from typing import TypedDict']);
    const lines = children(node, context, 'Field').filter(f => !f.data.derived).map(f => `    ${lastOf(f.qn)}: ${annotation(f.data.type as TypeData, context, imports)}`);
    const code = documented([`class ${lastOf(node.qn)}(TypedDict):`, ...(lines.length ? lines : ['    pass'])].join('\n'), node);
    return [template(`${appOf(node.module)}/values.py`, existing => pythonFile(existing, imports, code))];
}

export function entitySteps(entity: GraphNode, context: MapContext): Step[] {
    const imports = new Set(['from django.db import models']);
    const code = documented(modelClass(entity, context, imports), entity);
    const model = template(`${appOf(entity.module)}/models.py`, existing => pythonFile(existing, imports, code));
    if (userEntity(context) !== entity.qn) return [model];
    const setting = `AUTH_USER_MODEL = ${JSON.stringify(modelLabel(entity))}`;
    return [model, template('config/settings.py', existing => `${existing!.trimEnd()}\n\n${setting}\n`)];
}

/** The entity the actors are bound to with `is`, which becomes the Django user model; undefined unless there is exactly one. */
export function userEntity(context: MapContext): string | undefined {
    const bound = new Set(context.graph.nodes.filter(n => n.kind === 'Actor' && n.data.entity).map(n => n.data.entity as string));
    return bound.size === 1 ? [...bound][0] : undefined;
}

/** The Django user model that stores the actors and their fields. */
export interface UserModel {
    app: string;
    name: string;
    /** The entity the actors are bound to, when there is one. */
    entity?: GraphNode;
    /** Without a bound entity: the first actor with fields, which declares a `User` model for all of them. */
    owner?: GraphNode;
}

/**
 * The user model: the entity actors are bound to with `is`, or, when no actor is bound and some declare fields,
 * a `User` model in the module of the first such actor. Undefined when actors are bound to several entities,
 * or when the default `auth.User` will do.
 */
export function userModel(context: MapContext): UserModel | undefined {
    const qn = userEntity(context);
    if (qn) {
        const entity = context.node(qn)!;
        return { app: appOf(entity.module), name: lastOf(entity.qn), entity };
    }
    if (context.graph.nodes.some(n => n.kind === 'Actor' && n.data.entity)) return undefined;
    const owner = context.graph.nodes.find(n => n.kind === 'Actor' && context.children(n.qn).some(c => c.kind === 'Field'));
    if (!owner) return undefined;
    const taken = context.children(owner.module).some(n => lastOf(n.qn) === 'User');
    return { app: appOf(owner.module), name: taken ? 'ActorUser' : 'User', owner };
}

/** The fields declared on actors, one per name (the first declaration wins); stored on the user model. */
export function actorFields(context: MapContext): GraphNode[] {
    const byName = new Map<string, GraphNode>();
    for (const actor of context.graph.nodes.filter(n => n.kind === 'Actor')) {
        for (const field of children(actor, context, 'Field')) if (!byName.has(lastOf(field.qn))) byName.set(lastOf(field.qn), field);
    }
    return [...byName.values()];
}

/** The `AbstractUser` model of actors without a bound entity, holding the fields the actors declare. */
export function actorUserSteps(user: UserModel, context: MapContext): Step[] {
    const imports = new Set(['from django.db import models', 'from django.contrib.auth.models import AbstractUser']);
    const lines = actorFieldLines(context, imports, new Set());
    const code = [`class ${user.name}(AbstractUser):`, ...(lines.length ? lines : ['    pass'])].join('\n');
    return [
        template(`${user.app}/models.py`, existing => pythonFile(existing, imports, code)),
        template('config/settings.py', existing => `${existing!.trimEnd()}\n\nAUTH_USER_MODEL = ${JSON.stringify(`${user.app}.${user.name}`)}\n`)
    ];
}

/** Model lines for the actor fields that the user model does not already have; all are optional, since not every actor declares them. */
function actorFieldLines(context: MapContext, imports: Set<string>, existing: Set<string>): string[] {
    const lines: string[] = [];
    const fields = actorFields(context).filter(f => !existing.has(lastOf(f.qn)));
    for (const field of fields.filter(f => !f.data.derived)) {
        const optional = { ...field, data: { ...field.data, type: { ...(field.data.type as TypeData), optional: true } } };
        lines.push(`    ${lastOf(field.qn)} = ${djangoField(optional, context, imports)}`);
    }
    for (const field of fields.filter(f => f.data.derived)) {
        const code = property(field, context, imports);
        if (code) lines.push('', '    @property', `    def ${lastOf(field.qn)}(self):`, `        return ${code}`);
    }
    return lines;
}

export function fieldSteps(field: GraphNode, context: MapContext): Step[] | undefined {
    const owner = context.node(parentOf(field.qn))!.kind;
    if (owner === 'Event') return [];
    if (owner === 'Actor') {
        if (!userModel(context)) return [task(`store the actor field ${lastOf(field.qn)}, for example on the user model`)];
        return field.data.derived && !property(field, context, new Set()) ? [task(`implement the derived actor field ${lastOf(field.qn)} = ${field.props.derived}`)] : [];
    }
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
    const enforced = constraint(invariant, context) !== undefined;
    const rule = enforced ? [] : [task(`enforce the invariant "${invariant.data.label}": ${invariant.props.condition}`)];
    return [...rule, ...invariantTests(invariant, enforced, context)];
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
    const user = userEntity(context) === entity.qn;
    if (user) {
        const own = actorFieldLines(context, imports, new Set(fields.map(f => lastOf(f.qn))));
        if (own.length) lines.push(...(lines.length && own[0] !== '' ? [''] : []), ...own);
    }
    const constraints = children(entity, context, 'Invariant').flatMap(invariant => {
        const condition = constraint(invariant, context);
        const id = `${appOf(entity.module)}_${name}_${String(invariant.data.label)}`.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
        return condition ? [`            models.CheckConstraint(condition=${condition}, name=${JSON.stringify(id)}),`] : [];
    });
    if (constraints.length) lines.push('', '    class Meta:', '        constraints = [', ...constraints, '        ]');
    if (user) imports.add('from django.contrib.auth.models import AbstractUser');
    return [`class ${name}(${user ? 'AbstractUser' : 'models.Model'}):`, ...(lines.length ? lines : ['    pass'])].join('\n');
}

export function djangoField(field: GraphNode, context: MapContext, imports: Set<string>): string {
    const type = field.data.type as TypeData;
    const modifiers = (field.data.modifiers ?? []) as string[];
    const options: string[] = [];
    if (type.optional) options.push('null=True', 'blank=True');
    if (modifiers.includes('unique')) options.push('unique=True');
    if (typeof field.data.does === 'string') options.push(`help_text=${JSON.stringify(field.data.does)}`);
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

export function defaultValue(field: GraphNode, context: MapContext, imports: Set<string>): string | undefined {
    const expr = field.data.default as ExprData | undefined;
    if (!expr) return undefined;
    if (expr.$type === 'NameExpr' && expr.name === 'now' && !expr.target) {
        imports.add('from django.utils import timezone');
        return 'timezone.now';
    }
    return python(expr, scope(context, imports));
}

export function property(field: GraphNode, context: MapContext, imports: Set<string>): string | undefined {
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

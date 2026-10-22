import type { CodegenExtension, CommandStep, MapContext, Step } from '@appling/codegen';
import type { ExprData, GraphNode, TypeData } from '@appling/model';
import { ashExpr, constant, lastOf, parentOf, validation } from './elixir.js';

const TYPES: Record<string, string> = {
    String: 'string', Text: 'string', Int: 'integer', Decimal: 'decimal', Money: 'decimal', Bool: 'boolean',
    Date: 'date', DateTime: 'utc_datetime_usec', Duration: 'duration', File: 'string', Uuid: 'uuid'
};

const extension: CodegenExtension = {
    name: '@appling/codegen-ash',
    prerequisites: [
        { name: 'Elixir', command: ['mix', '--version'], expect: /Mix 1\.(1[7-9]|[2-9]\d)/, hint: 'install Elixir 1.17 or later' },
        { name: 'igniter_new', command: ['mix', 'help', 'igniter.new'], hint: 'run "mix archive.install hex igniter_new"' }
    ],

    setup: context => [
        { kind: 'command', run: ['mix', 'igniter.new', app(context), '--install', 'ash,ash_postgres', '--yes', '--no-git'], cwd: '..', creates: ['mix.exs', 'lib/'] }
    ],

    steps(node, context) {
        switch (node.kind) {
            case 'Module': return [mix(['ash.gen.domain', moduleName(node.qn, context)])];
            case 'Enum': return [mix(['ash.gen.enum', typeModule(node, context), context.children(node.qn).map(l => lastOf(l.qn)).join(',')])];
            case 'ValueType': return [{ kind: 'template', file: fileOf(node, context), write: () => embedded(node, context) }];
            case 'Entity': return entitySteps(node, context);
            case 'EnumLiteral': return [];
            case 'Field': return fieldSteps(node, context);
            case 'Invariant': return check(node, context) ? [] : [task(`enforce the invariant "${node.data.label}": ${node.props.condition}`)];
            case 'Policy': return node.layer === 'domain' ? [task(`add an Ash policy for ${(node.data.operations as string[] | undefined)?.join(', ') ?? 'any action'}: ${node.props.condition}`)] : undefined;
            default: return undefined;
        }
    }
};

export default extension;

function entitySteps(entity: GraphNode, context: MapContext): Step[] {
    const attributes = fieldsOf(entity, context).filter(f => !f.data.derived && !relationTarget(f, context));
    const specs = attributes.map(f => {
        const type = f.data.type as TypeData;
        return [lastOf(f.qn), attributeType(type, context), ...(type.many ? ['array'] : []), ...(type.optional ? [] : ['required']), 'public'].join(':');
    });
    return [
        mix(['ash.gen.resource', typeModule(entity, context), '--domain', moduleName(entity.module, context),
            '--default-actions', 'read,create,update,destroy', '--uuid-primary-key', 'id', ...(specs.length ? ['--attribute', specs.join(',')] : []),
            '--extend', 'postgres', '--timestamps']),
        { kind: 'template', file: fileOf(entity, context), write: existing => patchResource(existing!, entity, context) }
    ];
}

function fieldSteps(field: GraphNode, context: MapContext): Step[] | undefined {
    const owner = context.node(parentOf(field.qn))!;
    if (owner.kind === 'ValueType') return field.data.derived || field.data.default ? [task(`add ${lastOf(field.qn)} to the embedded resource: ${field.props.derived ?? field.props.default}`)] : [];
    if (owner.kind !== 'Entity') return undefined;
    const type = field.data.type as TypeData;
    const target = relationTarget(field, context);
    if (target && type.many) return [task(`model the many to many relationship ${lastOf(field.qn)} to ${target.qn}`)];
    if (target) {
        const spec = ['belongs_to', lastOf(field.qn), typeModule(target, context), ...(type.optional ? [] : ['required'])].join(':');
        return [{ ...mix(['ash.gen.resource', typeModule(owner, context), '--relationship', spec]), phase: 1 }];
    }
    const tasks: Step[] = [];
    if (field.data.derived && !calculation(field, context)) tasks.push(task(`add the calculation ${lastOf(field.qn)} = ${field.props.derived}`));
    if (field.data.default && defaultValue(field, context) === undefined) tasks.push(task(`set the default of ${lastOf(field.qn)} to ${field.props.default}`));
    return tasks;
}

/** Adds defaults, identities, calculations and validations to the resource `ash.gen.resource` created. */
function patchResource(text: string, entity: GraphNode, context: MapContext): string {
    const fields = fieldsOf(entity, context);
    for (const field of fields) {
        const value = defaultValue(field, context);
        if (value !== undefined) text = text.replace(new RegExp(`(\\n([ \\t]*)attribute :${lastOf(field.qn)}, [^\\n]* do\\n)`), `$1$2  default ${value}\n`);
    }
    const blocks = [
        block('identities', fields.filter(f => ((f.data.modifiers ?? []) as string[]).includes('unique')).map(f => `identity :unique_${lastOf(f.qn)}, [:${lastOf(f.qn)}]`)),
        block('calculations', fields.flatMap(f => calculation(f, context) ?? [])),
        block('validations', context.children(entity.qn).filter(n => n.kind === 'Invariant').flatMap(n => {
            const rule = check(n, context);
            return rule ? [`validate ${rule}, message: ${JSON.stringify(n.data.label)}`] : [];
        }))
    ].filter(Boolean).join('');
    return blocks ? text.replace(/\nend\n?$/, `\n${blocks}end\n`) : text;
}

function block(name: string, lines: string[]): string {
    return lines.length ? `\n  ${name} do\n${lines.map(l => `    ${l}\n`).join('')}  end\n` : '';
}

function calculation(field: GraphNode, context: MapContext): string | undefined {
    const type = field.data.type as TypeData;
    const body = field.data.derived && !type.many && ashExpr(field.data.derived as ExprData, context.node);
    return body ? `calculate :${lastOf(field.qn)}, ${attributeType(type, context, true)}, expr(${body})` : undefined;
}

function check(invariant: GraphNode, context: MapContext): string | undefined {
    const stored = new Set(fieldsOf(context.node(parentOf(invariant.qn))!, context).filter(f => !f.data.derived && !relationTarget(f, context)).map(f => f.qn));
    return validation(invariant.data.condition as ExprData, stored, context.node);
}

function defaultValue(field: GraphNode, context: MapContext): string | undefined {
    const expr = field.data.default as ExprData | undefined;
    if (!expr) return undefined;
    if (expr.$type === 'NameExpr' && expr.name === 'now' && !expr.target) return '&DateTime.utc_now/0';
    return constant(expr, context.node);
}

function embedded(node: GraphNode, context: MapContext): string {
    const attributes = fieldsOf(node, context).filter(f => !f.data.derived).map(f => {
        const type = f.data.type as TypeData;
        const elixirType = type.many ? `{:array, ${attributeType(type, context, true)}}` : attributeType(type, context, true);
        return `    attribute :${lastOf(f.qn)}, ${elixirType}, allow_nil?: ${type.optional ? 'true' : 'false'}, public?: true\n`;
    });
    return `defmodule ${typeModule(node, context)} do\n  use Ash.Resource, data_layer: :embedded\n\n  attributes do\n${attributes.join('')}  end\nend\n`;
}

function attributeType(type: TypeData, context: MapContext, asCode = false): string {
    if (type.primitive) return asCode ? `:${TYPES[type.primitive]}` : TYPES[type.primitive];
    return typeModule(context.node(type.decl!)!, context);
}

function relationTarget(field: GraphNode, context: MapContext): GraphNode | undefined {
    const decl = (field.data.type as TypeData | undefined)?.decl;
    const target = decl ? context.node(decl) : undefined;
    return target?.kind === 'Entity' ? target : undefined;
}

function fieldsOf(node: GraphNode, context: MapContext): GraphNode[] {
    return context.children(node.qn).filter(f => f.kind === 'Field');
}

function app(context: MapContext): string {
    return context.name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
}

function moduleName(moduleQn: string, context: MapContext): string {
    return [app(context), ...moduleQn.split('.')].map(pascal).join('.');
}

function typeModule(node: GraphNode, context: MapContext): string {
    return `${moduleName(node.module, context)}.${lastOf(node.qn)}`;
}

function fileOf(node: GraphNode, context: MapContext): string {
    return ['lib', app(context), ...node.module.split('.').map(snake), `${snake(lastOf(node.qn))}.ex`].join('/');
}

function pascal(name: string): string {
    return name.split('_').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('');
}

function snake(name: string): string {
    return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

function mix(args: string[]): CommandStep {
    return { kind: 'command', run: ['mix', ...args, '--yes'] };
}

function task(what: string): Step {
    return { kind: 'task', what };
}

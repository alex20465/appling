import type { CodegenExtension, MapContext, Step } from '@appling/codegen';
import type { ExprData, GraphNode, TypeData } from '@appling/model';
import { interfaceSteps } from './api.js';
import { projectionFieldSteps, querySteps } from './application.js';
import { actionSteps, jobSteps, machineSteps } from './behavior.js';
import { ashExpr, constant, lastOf, parentOf, validation } from './elixir.js';
import { testSteps } from './tests.js';
import { app, attributeType, fieldsOf, fileOf, mix, moduleName, patch, relationTarget, storedAttributes, task, typeModule } from './naming.js';

const extension: CodegenExtension = {
    name: '@appling/codegen-ash',
    test: ['mix', 'test'],
    prerequisites: [
        { name: 'Elixir', command: ['mix', '--version'], expect: /Mix 1\.(1[7-9]|[2-9]\d)/, hint: 'install Elixir 1.17 or later' },
        { name: 'igniter_new', command: ['mix', 'help', 'igniter.new'], hint: 'run "mix archive.install hex igniter_new"' }
    ],

    setup: context => {
        const has = (kind: string, test: (n: GraphNode) => boolean = () => true) => context.graph.nodes.some(n => n.kind === kind && test(n));
        const install = ['ash', 'ash_postgres', ...(has('Machine') ? ['ash_state_machine'] : []), ...(has('Job', j => !!j.data.schedule) ? ['ash_oban'] : [])];
        return [
            { kind: 'command', run: ['mix', 'igniter.new', app(context), '--install', install.join(','), '--yes', '--no-git'], cwd: '..', creates: ['mix.exs', 'lib/'] },
            ...(has('Interface', i => i.data.protocol === 'rest') ? [mix(['igniter.install', 'ash_json_api,bandit'])] : [])
        ];
    },

    steps(node, context) {
        switch (node.kind) {
            case 'Module': return [mix(['ash.gen.domain', moduleName(node.qn, context)])];
            case 'Enum': return [mix(['ash.gen.enum', typeModule(node, context), context.children(node.qn).map(l => lastOf(l.qn)).join(',')])];
            case 'ValueType': return [{ kind: 'template', file: fileOf(node, context), write: () => embedded(node, context) }];
            case 'Entity': return entitySteps(node, context);
            case 'EnumLiteral': return [];
            case 'Field': return fieldSteps(node, context);
            case 'Invariant': return [
                ...(check(node, context) ? [] : [task(`enforce the invariant "${node.data.label}": ${node.props.condition}`)]),
                ...testSteps(node, owner(node, context), `invariant ${node.data.label}`, ['holds for valid records', 'rejects violations'], context)
            ];
            case 'Policy': return [
                task(`add an Ash policy to ${parentOf(node.qn)} for ${(node.data.operations as string[] | undefined)?.join(', ') ?? 'any action'}: ${node.props.condition}`),
                ...(context.node(parentOf(node.qn))!.kind === 'Entity'
                    ? testSteps(node, owner(node, context), lastOf(node.qn), ['allows permitted actors', 'denies other actors'], context)
                    : [])
            ];
            case 'Transition': return transitionTests(node, context);
            case 'Action': return actionSteps(node, context);
            case 'Machine': return machineSteps(node, context);
            case 'Job': return jobSteps(node, context);
            case 'Query': return querySteps(node, context);
            case 'ProjectionField': return projectionFieldSteps(node, context);
            case 'Interface': return interfaceSteps(node, context);
            case 'Event': return [task(`publish ${lastOf(node.qn)} with an Ash notifier, for example Ash.Notifier.PubSub`)];
            case 'External': return [task(`implement ${lastOf(node.qn)} as a client module or generic actions`)];
            case 'UseCase': return [task(`implement ${lastOf(node.qn)} as a Reactor or a generic action`)];
            case 'Role': return [task(`model the role ${lastOf(node.qn)} on the actor resource`)];
            case 'Param':
            case 'ErrorDecl':
            case 'SetEffect':
            case 'CreateEffect':
            case 'EmitEffect':
            case 'Projection':
            case 'ExternalOperation':
            case 'Endpoint':
                return [];
            default: return undefined;
        }
    }
};

export default extension;

function owner(node: GraphNode, context: MapContext): GraphNode {
    return context.node(parentOf(node.qn))!;
}

function transitionTests(transition: GraphNode, context: MapContext): Step[] {
    const machine = owner(transition, context);
    const entity = owner(context.node(machine.data.field as string)!, context);
    const title = `transition ${(transition.data.from as string[]).join(', ')} -> ${transition.data.to}`;
    return testSteps(transition, entity, title, ['moves from allowed states', 'refuses other states'], context);
}

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
        patch(fileOf(entity, context), existing => patchResource(existing, entity, context))
    ];
}

function fieldSteps(field: GraphNode, context: MapContext): Step[] | undefined {
    const owner = context.node(parentOf(field.qn))!;
    if (owner.kind === 'ValueType') return field.data.derived || field.data.default ? [task(`add ${lastOf(field.qn)} to the embedded resource: ${field.props.derived ?? field.props.default}`)] : [];
    if (owner.kind === 'Event') return [];
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
    return validation(invariant.data.condition as ExprData, storedAttributes(context.node(parentOf(invariant.qn))!, context), context.node);
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


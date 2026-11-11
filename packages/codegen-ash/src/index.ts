import type { CodegenExtension, MapContext, Step } from '@appling/codegen';
import type { GraphNode, TypeData } from '@appling/model';
import { interfaceSteps } from './api.js';
import { projectionFieldSteps, querySteps } from './application.js';
import { actionSteps, jobSteps, machineSteps } from './behavior.js';
import { elixirString, lastOf, parentOf, withModuledoc } from './elixir.js';
import { eventSteps } from './events.js';
import { migrationSteps } from './migrations.js';
import { hasPages, navigationSteps, pageSteps } from './pages.js';
import { actorAttributeSpecs, actorFieldSteps, actorSteps, constrainRoles, homeAt, homeFields } from './actors.js';
import { actorCheckSteps, closeResource, enforced, policySteps, policyTask, roleCalculations, roleSteps } from './roles.js';
import { tenantSteps } from './tenants.js';
import { check, defaultValue, invariantTests, transitionTests } from './model-tests.js';
import { policyTests } from './policy-tests.js';
import { coveredByScenario, scenarioSteps } from './scenario-tests.js';
import { externalKeySteps, secretPlaceholders } from './vendors.js';
import { app, attributeType, calculation, fieldPolicyOf, fieldsOf, fileOf, mix, moduleName, patch, relationTarget, leftToCode, task, typeModule } from './naming.js';

const extension: CodegenExtension = {
    name: '@appling/codegen-ash',
    test: ['mix', 'test'],
    syncExclude: ['deps/**', '_build/**', 'priv/repo/migrations/**', 'priv/resource_snapshots/**', 'priv/static/**', 'mix.lock'],
    migrate: migrationSteps,
    prerequisites: [
        { name: 'Elixir', command: ['mix', '--version'], expect: /Mix 1\.(1[7-9]|[2-9]\d)/, hint: 'install Elixir 1.17 or later' },
        { name: 'igniter_new', command: ['mix', 'help', 'igniter.new'], hint: 'run "mix archive.install hex igniter_new"' },
        { name: 'phx_new', command: ['mix', 'help', 'phx.new'], hint: 'run "mix archive.install hex phx_new"; models with pages become Phoenix applications', needed: graph => graph.nodes.some(n => n.kind === 'Page') }
    ],

    setup: context => {
        const has = (kind: string, test: (n: GraphNode) => boolean = () => true) => context.graph.nodes.some(n => n.kind === kind && test(n));
        const pages = hasPages(context);
        const api = has('Interface', i => i.data.protocol === 'rest');
        const install = [
            // Ash policies need a SAT solver; simple_sat is pure Elixir, so the project builds without a C compiler.
            'ash', 'ash_postgres', ...(enforced(context) ? ['simple_sat'] : []), ...(pages ? ['ash_phoenix'] : []), ...(has('Machine') ? ['ash_state_machine'] : []),
            ...(has('Job', j => !!j.data.schedule) ? ['ash_oban'] : []),
            // Events publish through :telemetry, which Ash already pulls in; a direct dependency keeps the compiler quiet.
            ...(has('Event') ? ['telemetry'] : []), ...(pages && api ? ['ash_json_api'] : [])
        ];
        return [
            { kind: 'command', run: ['mix', 'igniter.new', app(context), ...(pages ? ['--with', 'phx.new', '--with-args=--no-install'] : []), '--install', install.join(','), '--yes', '--no-git'], cwd: '..', creates: ['mix.exs', 'lib/'] },
            ...(api && !pages ? [mix(['igniter.install', 'ash_json_api,bandit'])] : []),
            { kind: 'command', run: ['mix', 'ash.codegen', 'initial_resources'], phase: 3, ...secretPlaceholders(context) }
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
                ...invariantTests(node, context)
            ];
            case 'Policy': return [
                ...(policySteps(node, context) ?? [policyTask(node)]),
                ...(context.node(parentOf(node.qn))!.kind === 'Entity'
                    ? policyTests(node, context)
                    : [])
            ];
            // A scenario that runs the transition's action replaces its guessed tests.
            case 'Transition': return coveredByScenario(node.qn, context) ? [] : transitionTests(node, context);
            case 'Scenario': return scenarioSteps(node, context);
            case 'Action': return actionSteps(node, context);
            case 'Machine': return machineSteps(node, context);
            case 'Job': return jobSteps(node, context);
            case 'Query': return querySteps(node, context);
            case 'ProjectionField': return projectionFieldSteps(node, context);
            case 'Interface': return interfaceSteps(node, context);
            case 'Page': return pageSteps(node, context);
            case 'Navigation': return navigationSteps(node, context);
            case 'Messages': return [];
            case 'Flow': return [task(`guide people through ${((node.data.pages ?? []) as string[]).map(p => p.split('.').pop()).join(', ')} for the use case ${String(node.data.usecase).split('.').pop()}, for example with links between the LiveViews`)];
            case 'Event': return eventSteps(node, context);
            case 'External': return [leftToCode(`implement ${lastOf(node.qn)} as a client module or generic actions`)];
            case 'ExternalKey': return externalKeySteps(node, context);
            case 'UseCase': return [task(`implement ${lastOf(node.qn)} as a Reactor or a generic action`)];
            case 'Role': return roleSteps(node, context);
            case 'Actor': return [...actorSteps(node, context, patchResource), ...actorCheckSteps(node, context)];
            case 'Tenant': return tenantSteps(node, context);
            case 'Param':
            case 'ErrorDecl':
            case 'SetEffect':
            case 'CreateEffect':
            case 'EmitEffect':
            case 'ForEffect':
            case 'UpdateEffect':
            case 'DeleteEffect':
            case 'Projection':
            case 'ExternalOperation':
            case 'Endpoint':
                return [];
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
    // The fields of the actors bound to the entity, and their roles, which are not public, so nobody assigns roles to themselves through the API.
    specs.push(...actorAttributeSpecs(entity, context));
    return [
        { ...mix(['ash.gen.resource', typeModule(entity, context), '--domain', moduleName(entity.module, context),
            '--default-actions', 'read,create,update,destroy', '--uuid-primary-key', 'id', ...(specs.length ? ['--attribute', specs.join(',')] : []),
            '--extend', 'postgres', '--timestamps']), creates: [fileOf(entity, context)] },
        patch(fileOf(entity, context), existing => patchResource(existing, entity, context))
    ];
}

function fieldSteps(field: GraphNode, context: MapContext): Step[] | undefined {
    const owner = context.node(parentOf(field.qn))!;
    if (owner.kind === 'ValueType') return field.data.derived || field.data.default ? [task(`add ${lastOf(field.qn)} to the embedded resource: ${field.props.derived ?? field.props.default}`)] : [];
    if (owner.kind === 'Event') return [];
    if (owner.kind === 'Actor') return actorFieldSteps(field, context);
    if (owner.kind !== 'Entity') return undefined;
    const type = field.data.type as TypeData;
    const target = relationTarget(field, context);
    if (target && type.many) return [task(`model the many to many relationship ${lastOf(field.qn)} to ${target.qn}`)];
    if (target) {
        const spec = ['belongs_to', lastOf(field.qn), typeModule(target, context), ...(type.optional ? [] : ['required'])].join(':');
        return [{ ...mix(['ash.gen.resource', typeModule(owner, context), '--relationship', spec]), phase: 1 }];
    }
    const tasks: Step[] = [];
    if (field.data.derived && !calculation(field, context)) {
        // Until the calculation exists, its field policy has nothing to name; the task carries the policy's condition.
        const policy = fieldPolicyOf(field, context);
        tasks.push(task(`add the calculation ${lastOf(field.qn)} = ${field.props.derived}${policy ? `, public?: true, and add it to the field policy of ${policy.qn}: ${policy.props.condition}` : ''}`));
    }
    if (field.data.default && defaultValue(field, context) === undefined) tasks.push(task(`set the default of ${lastOf(field.qn)} to ${field.props.default}`));
    return tasks;
}

/** Adds defaults, identities, calculations and validations to the resource `ash.gen.resource` created, for an entity or an actor. */
function patchResource(text: string, entity: GraphNode, context: MapContext): string {
    const home = homeAt(entity, context);
    const fields = home?.resource ? homeFields(home, context) : fieldsOf(entity, context);
    if (home?.resource) text = constrainRoles(text, home);
    for (const field of fields) {
        const value = defaultValue(field, context);
        if (value !== undefined) text = text.replace(new RegExp(`(\\n([ \\t]*)attribute :${lastOf(field.qn)}, [^\\n]* do\\n)`), `$1$2  default ${value}\n`);
        if (typeof field.data.does === 'string') text = text.replace(new RegExp(`(\\n([ \\t]*)attribute :${lastOf(field.qn)}, [^\\n]* do\\n)`), (_, head: string, indent: string) => `${head}${indent}  description ${elixirString(field.data.does as string)}\n`);
    }
    text = withModuledoc(text, entity);
    const blocks = [
        block('identities', fields.filter(f => ((f.data.modifiers ?? []) as string[]).includes('unique')).map(f => `identity :unique_${lastOf(f.qn)}, [:${lastOf(f.qn)}]`)),
        block('calculations', [...fields.flatMap(f => calculation(f, context) ?? []), ...roleCalculations(entity, context)]),
        block('validations', context.children(entity.qn).filter(n => n.kind === 'Invariant').flatMap(n => {
            const rule = check(n, context);
            return rule ? [`validate ${rule}, message: ${JSON.stringify(n.data.label)}`] : [];
        }))
    ].filter(Boolean).join('');
    return closeResource(blocks ? text.replace(/\nend\n?$/, `\n${blocks}end\n`) : text, entity, context);
}

function block(name: string, lines: string[]): string {
    return lines.length ? `\n  ${name} do\n${lines.map(l => `    ${l}\n`).join('')}  end\n` : '';
}

function embedded(node: GraphNode, context: MapContext): string {
    const attributes = fieldsOf(node, context).filter(f => !f.data.derived).map(f => {
        const type = f.data.type as TypeData;
        const elixirType = type.many ? `{:array, ${attributeType(type, context, true)}}` : attributeType(type, context, true);
        return `    attribute :${lastOf(f.qn)}, ${elixirType}, allow_nil?: ${type.optional ? 'true' : 'false'}, public?: true\n`;
    });
    return withModuledoc(`defmodule ${typeModule(node, context)} do\n  use Ash.Resource, data_layer: :embedded\n\n  attributes do\n${attributes.join('')}  end\nend\n`, node);
}


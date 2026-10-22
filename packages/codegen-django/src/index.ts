import type { CodegenExtension, MapContext, Step } from '@appling/codegen';
import { interfaceSteps } from './api.js';
import { externalSteps, projectionFieldSteps, projectionSteps, querySteps, useCaseSteps } from './application.js';
import { actionSteps, errorSteps, eventSteps, jobSteps, machineSteps } from './behavior.js';
import { hasKind, task } from './files.js';
import { entitySteps, enumSteps, fieldSteps, installApp, invariantSteps, moduleSteps, policyTask, valueSteps } from './models.js';

const DJANGO = 'django~=6.1.0';
const REST_FRAMEWORK = 'djangorestframework~=3.16';

const extension: CodegenExtension = {
    name: '@appling/codegen-django',
    prerequisites: [{ name: 'uv', command: ['uv', '--version'], expect: /^uv \d+\.\d+/, hint: 'install uv (https://docs.astral.sh/uv/) to manage the Python project' }],
    setup,

    steps(node, context) {
        switch (node.kind) {
            case 'Module': return moduleSteps(node);
            case 'Enum': return enumSteps(node, context);
            case 'ValueType': return valueSteps(node, context);
            case 'Entity': return entitySteps(node, context);
            case 'Field': return fieldSteps(node, context);
            case 'Invariant': return invariantSteps(node, context);
            case 'Policy': return [policyTask(node)];
            case 'Event': return eventSteps(node);
            case 'Action': return actionSteps(node, context);
            case 'ErrorDecl': return errorSteps(node);
            case 'Machine': return machineSteps(node, context);
            case 'Job': return jobSteps(node, context);
            case 'Query': return querySteps(node, context);
            case 'Projection': return projectionSteps(node, context);
            case 'ProjectionField': return projectionFieldSteps(node, context);
            case 'External': return externalSteps(node, context);
            case 'UseCase': return useCaseSteps(node, context);
            case 'Interface': return interfaceSteps(node, context);
            case 'EnumLiteral':
            case 'Param':
            case 'Transition':
            case 'SetEffect':
            case 'CreateEffect':
            case 'EmitEffect':
            case 'ExternalOperation':
            case 'Endpoint':
                return [];
            case 'Role': return [task(`create the Django group ${node.qn.split('.').pop()} for the role`)];
            default: return undefined;
        }
    }
};

export default extension;

function setup(context: MapContext): Step[] {
    const api = hasKind(context, 'Projection', 'Interface');
    return [
        { kind: 'command', run: ['uv', 'init', '--bare', '--name', context.name], creates: ['pyproject.toml'] },
        { kind: 'command', run: ['uv', 'add', DJANGO, ...(api ? [REST_FRAMEWORK] : [])], creates: ['uv.lock'] },
        { kind: 'command', run: ['uv', 'run', 'django-admin', 'startproject', 'config', '.'], creates: ['manage.py', 'config/'] },
        ...(api ? [installApp('rest_framework')] : [])
    ];
}

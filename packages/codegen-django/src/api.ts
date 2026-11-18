import type { MapContext, Step } from '@appling/codegen';
import type { GraphNode } from '@appling/model';
import { inputLines, pageSizeName, queryCall, queryCode } from './application.js';
import { children, comment, includeStep, pythonFile, routesStep, task, template } from './files.js';
import { appOf, lastOf, snake } from './python.js';
import { vendorTasks } from './vendors.js';

const WRITES = ['POST', 'PUT', 'PATCH', 'DELETE'];

/** A REST interface becomes REST framework views in `api.py` and its routes in `api_urls.py`, mounted under `api/`. */
export function interfaceSteps(api: GraphNode, context: MapContext): Step[] | undefined {
    if (api.data.protocol === 'webhook') return vendorTasks(api, context);
    if (api.data.protocol !== 'rest') return undefined;
    const app = appOf(api.module);
    const name = lastOf(api.qn);
    const imports = new Set<string>();
    const blocks: string[] = [];
    const routes: string[] = [];
    const tasks: Step[] = [];
    const throttle = api.data.rateLimit ? `${name}Throttle` : undefined;
    if (throttle) {
        imports.add('from rest_framework import throttling');
        blocks.push(context.render('api/throttle.py.njk', { name: throttle, rate: `${api.data.rateLimit}/${api.data.rateUnit}` }));
    }
    for (const endpoint of children(api, context, 'Endpoint')) {
        const view = endpointView(endpoint, `${name}${pascal(lastOf(endpoint.data.target as string))}`, throttle, context, imports);
        if (!view) {
            tasks.push(task(`expose ${endpoint.data.verb} ${endpoint.data.path} -> ${lastOf(endpoint.data.target as string)}`));
            continue;
        }
        blocks.push(view.code);
        routes.push(`    path(${JSON.stringify(djangoPath(endpoint.data.path as string))}, api.${view.name}.as_view()),`);
    }
    if (api.data.auth) tasks.push(task(`configure ${api.data.auth} authentication for ${name} in REST_FRAMEWORK settings`), ...vendorTasks(api, context));
    if ((api.data.origins as string[] | undefined)?.length) tasks.push(task(`allow the CORS origins ${(api.data.origins as string[]).join(', ')} for ${name}, for example with django-cors-headers`));
    if (!blocks.length) return tasks;
    const about = comment(api);
    return [
        template(`${app}/api.py`, existing => pythonFile(existing, imports, `${about && `${about}\n`}${blocks.join('\n\n\n')}`)),
        routesStep(app, 'api_urls', 'api', routes, context),
        includeStep(app, 'api_urls', 'api/'),
        ...tasks
    ];
}

function endpointView(endpoint: GraphNode, name: string, throttle: string | undefined, context: MapContext, imports: Set<string>): { name: string, code: string } | undefined {
    const target = context.node(endpoint.data.target as string)!;
    const verb = endpoint.data.verb as string;
    if (verb === 'GET' && target.kind === 'Query' && endpoint.data.projection) {
        if (!queryCode(target, context, new Set())) return undefined;
        // The inputs come from the path and the query string; parameters that do not parse answer 400.
        const inputs = inputLines(target, ['self.request.query_params', 'self.kwargs'], undefined, context, imports);
        if (!inputs) return undefined;
        const projection = context.node(endpoint.data.projection as string)!;
        const picks = ((endpoint.data.picks ?? []) as string[]).map(lastOf);
        imports.add('from rest_framework import generics');
        imports.add(`from ${appOf(target.module)}.queries import ${snake(lastOf(target.qn))}`);
        imports.add(`from ${appOf(projection.module)}.serializers import ${lastOf(projection.qn)}`);
        if (target.data.pageSize) {
            imports.add('from rest_framework import pagination');
            imports.add(`from ${appOf(target.module)}.queries import ${pageSizeName(target)}`);
        }
        const code = context.render('api/list-view.py.njk', {
            name,
            projection: lastOf(projection.qn),
            serializer: picks.length ? `${name}Serializer` : lastOf(projection.qn),
            picks,
            pageSize: target.data.pageSize ? pageSizeName(target) : '',
            throttle: throttle ?? '',
            inputs,
            query: queryCall(target, 'self.request.user', context, inputs.length ? ['**inputs.validated_data'] : [])
        });
        return { name, code };
    }
    if (WRITES.includes(verb) && target.kind === 'Action') {
        const entity = target.data.entity ? context.node(target.data.entity as string) : undefined;
        const path = endpoint.data.path as string;
        if (entity && !path.includes('{id}')) return undefined;
        const action = snake(lastOf(target.qn));
        const instance = entity ? snake(lastOf(entity.qn)) : undefined;
        const errors = context.graph.nodes.some(n => n.kind === 'Transition' && n.data.action === target.qn) ? ['InvalidTransition'] : [];
        errors.push(...children(target, context, 'ErrorDecl').map(e => lastOf(e.qn)));
        imports.add('from rest_framework import views');
        imports.add('from rest_framework.response import Response');
        imports.add(`from ${appOf(target.module)}.actions import ${action}`);
        if (errors.length) imports.add(`from ${appOf(target.module)}.errors import ${errors.join(', ')}`);
        if (entity) {
            imports.add('from django.shortcuts import get_object_or_404');
            imports.add(`from ${appOf(entity.module)}.models import ${lastOf(entity.qn)}`);
        }
        const inputs = children(target, context, 'Param').map(p => `${lastOf(p.qn)}=request.data.get(${JSON.stringify(lastOf(p.qn))})`);
        const code = context.render('api/action-view.py.njk', {
            name,
            throttle: throttle ?? '',
            method: verb.toLowerCase(),
            instance: instance ?? '',
            model: entity ? lastOf(entity.qn) : '',
            errors,
            call: `${action}(${[...(instance ? [instance] : []), ...inputs, 'actor=request.user'].join(', ')})`
        });
        return { name, code };
    }
    return undefined;
}

/** `/orders/{id}/place` becomes `orders/<int:id>/place`. */
function djangoPath(path: string): string {
    return path.replace(/^\//, '').replace(/\{id\}/g, '<int:id>').replace(/\{(\w+)\}/g, '<str:$1>');
}

function pascal(name: string): string {
    return name.charAt(0).toUpperCase() + name.slice(1);
}

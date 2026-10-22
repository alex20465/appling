import type { MapContext, Step } from '@appling/codegen';
import type { GraphNode } from '@appling/model';
import { pageSizeName, queryCode } from './application.js';
import { children, pythonFile, task, template } from './files.js';
import { appOf, lastOf, snake } from './python.js';

const WRITES = ['POST', 'PUT', 'PATCH', 'DELETE'];

/** A REST interface becomes REST framework views in `api.py`, its routes in `urls.py`, mounted at the site root. */
export function interfaceSteps(api: GraphNode, context: MapContext): Step[] | undefined {
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
        blocks.push(`class ${throttle}(throttling.UserRateThrottle):\n    rate = ${JSON.stringify(`${api.data.rateLimit}/${api.data.rateUnit}`)}`);
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
    if (api.data.auth) tasks.push(task(`configure ${api.data.auth} authentication for ${name} in REST_FRAMEWORK settings`));
    if ((api.data.origins as string[] | undefined)?.length) tasks.push(task(`allow the CORS origins ${(api.data.origins as string[]).join(', ')} for ${name}, for example with django-cors-headers`));
    if (!blocks.length) return tasks;
    return [
        template(`${app}/api.py`, existing => pythonFile(existing, imports, blocks.join('\n\n\n'))),
        template(`${app}/urls.py`, existing => existing
            ? existing.replace(/\n\]\n$/, `\n${routes.join('\n')}\n]\n`)
            : pythonFile(undefined, ['from django.urls import path', `from ${app} import api`], `urlpatterns = [\n${routes.join('\n')}\n]`)),
        template('config/urls.py', existing => existing!.includes(`include("${app}.urls")`) ? existing! : existing!
            .replace('from django.urls import path', 'from django.urls import include, path')
            .replace(/urlpatterns = \[\n([\s\S]*?)\]/, (_, paths) => `urlpatterns = [\n${paths}    path("", include("${app}.urls")),\n]`)),
        ...tasks
    ];
}

function endpointView(endpoint: GraphNode, name: string, throttle: string | undefined, context: MapContext, imports: Set<string>): { name: string, code: string } | undefined {
    const target = context.node(endpoint.data.target as string)!;
    const verb = endpoint.data.verb as string;
    const throttles = throttle ? [`    throttle_classes = [${throttle}]`] : [];
    if (verb === 'GET' && target.kind === 'Query' && endpoint.data.projection) {
        if (!queryCode(target, context, new Set())) return undefined;
        const projection = context.node(endpoint.data.projection as string)!;
        const picks = ((endpoint.data.picks ?? []) as string[]).map(p => JSON.stringify(lastOf(p)));
        imports.add('from rest_framework import generics');
        imports.add(`from ${appOf(target.module)}.queries import ${snake(lastOf(target.qn))}`);
        imports.add(`from ${appOf(projection.module)}.serializers import ${lastOf(projection.qn)}`);
        const lines: string[] = [];
        let serializer = lastOf(projection.qn);
        if (picks.length) {
            serializer = `${name}Serializer`;
            lines.push(`class ${serializer}(${lastOf(projection.qn)}):`, `    class Meta(${lastOf(projection.qn)}.Meta):`, `        fields = [${picks.join(', ')}]`, '', '');
        }
        if (target.data.pageSize) {
            imports.add('from rest_framework import pagination');
            imports.add(`from ${appOf(target.module)}.queries import ${pageSizeName(target)}`);
            lines.push(`class ${name}Pagination(pagination.PageNumberPagination):`, `    page_size = ${pageSizeName(target)}`, '', '');
        }
        lines.push(
            `class ${name}(generics.ListAPIView):`,
            `    serializer_class = ${serializer}`,
            ...(target.data.pageSize ? [`    pagination_class = ${name}Pagination`] : []),
            ...throttles,
            '',
            '    def get_queryset(self):',
            `        return ${snake(lastOf(target.qn))}()`
        );
        return { name, code: lines.join('\n') };
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
        const call = `${action}(${[...(instance ? [instance] : []), ...inputs, 'actor=request.user'].join(', ')})`;
        const body = errors.length
            ? ['        try:', `            ${call}`, `        except (${errors.join(', ')}${errors.length === 1 ? ',' : ''}) as error:`, '            return Response({"error": type(error).__name__}, status=400)']
            : [`        ${call}`];
        return {
            name,
            code: [
                `class ${name}(views.APIView):`,
                ...throttles,
                ...(throttles.length ? [''] : []),
                `    def ${verb.toLowerCase()}(self, request${entity ? ', id' : ''}):`,
                ...(entity ? [`        ${instance} = get_object_or_404(${lastOf(entity.qn)}, pk=id)`] : []),
                ...body,
                '        return Response(status=204)'
            ].join('\n')
        };
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

import type { MapContext, Step } from '@appling/codegen';
import type { GraphNode } from '@appling/model';
import { lastOf } from './elixir.js';
import { app, children, fileOf, moduleName, pascal, patch, snake, task, typeModule } from './naming.js';
import { addExtension, addToSection } from './resource.js';

/**
 * A REST interface becomes AshJsonApi routes on the domain, served by a JSON:API router that Bandit
 * starts with the application, without Phoenix.
 */
export function interfaceSteps(api: GraphNode, context: MapContext): Step[] | undefined {
    if (api.data.protocol !== 'rest') return undefined;
    const tasks: Step[] = [];
    const routes = new Map<GraphNode, string[]>();
    for (const endpoint of children(api, context, 'Endpoint')) {
        const route = endpointRoute(endpoint, context);
        if (!route) {
            tasks.push(task(`expose ${endpoint.data.verb} ${endpoint.data.path} -> ${lastOf(endpoint.data.target as string)}`));
            continue;
        }
        routes.set(route.resource, [...(routes.get(route.resource) ?? []), route.line]);
        if (route.note) tasks.push(task(route.note));
    }
    if (api.data.auth) tasks.push(task(`authenticate ${lastOf(api.qn)} with ${api.data.auth}, for example with AshAuthentication`));
    if (api.data.rateLimit) tasks.push(task(`limit ${lastOf(api.qn)} to ${api.data.rateLimit} requests per ${api.data.rateUnit}`));
    if ((api.data.origins as string[] | undefined)?.length) tasks.push(task(`allow the CORS origins ${(api.data.origins as string[]).join(', ')} for ${lastOf(api.qn)}`));
    if (!routes.size) return tasks;
    const domain = moduleName(api.module, context);
    const router = `${pascal(app(context))}.ApiRouter`;
    const resourceSteps: Step[] = [...routes].flatMap(([resource, lines]) => [
        patch(fileOf(resource, context), existing => existing.includes('\n  json_api do\n') ? existing : addToSection(addExtension(existing, 'AshJsonApi.Resource'), 'json_api', [`type ${JSON.stringify(snake(lastOf(resource.qn)))}`])),
        patch(domainFile(api, context), existing => addToSection(addExtension(existing, 'AshJsonApi.Domain'), 'json_api', [`base_route "/", ${typeModule(resource, context)} do`, ...lines.map(l => `  ${l}`), 'end'], 'routes'))
    ]);
    return [
        ...resourceSteps,
        {
            kind: 'template', phase: 2, file: `lib/${app(context)}/api_router.ex`, write: existing => existing
                ? existing.replace(/domains: \[([^\]]*)\]/, (all, list) => list.includes(domain) ? all : `domains: [${list}, ${domain}]`)
                : `defmodule ${router} do\n  use AshJsonApi.Router, domains: [${domain}], open_api: "/open_api"\nend\n`
        },
        patch(`lib/${app(context)}/application.ex`, existing => existing.includes('Bandit')
            ? existing
            : existing.replace(/children = \[\n/, `children = [\n      {Bandit, plug: ${router}, port: 4000},\n`)),
        ...tasks
    ];
}

/** The route line for one endpoint, relative to "/" of its resource. */
function endpointRoute(endpoint: GraphNode, context: MapContext): { resource: GraphNode, line: string, note?: string } | undefined {
    const target = context.node(endpoint.data.target as string)!;
    const verb = endpoint.data.verb as string;
    const path = (endpoint.data.path as string).replace(/\{id\}/g, ':id').replace(/\{(\w+)\}/g, ':$1');
    if (verb === 'GET' && target.kind === 'Query') {
        const fields = ((endpoint.data.picks ?? []) as string[]).map(p => `:${lastOf(p)}`);
        const options = [`route: ${JSON.stringify(path)}`, ...(fields.length ? [`default_fields: [${fields.join(', ')}]`] : [])];
        return { resource: context.node(target.data.entity as string)!, line: `index :${snake(lastOf(target.qn))}, ${options.join(', ')}` };
    }
    if (['POST', 'PUT', 'PATCH'].includes(verb) && target.kind === 'Action' && target.data.entity && path.includes(':id')) {
        const note = verb === 'PATCH' ? undefined : `${verb} ${endpoint.data.path} is served as PATCH, the JSON:API method for update actions`;
        return { resource: context.node(target.data.entity as string)!, line: `patch :${snake(lastOf(target.qn))}, route: ${JSON.stringify(path)}`, note };
    }
    return undefined;
}

function domainFile(api: GraphNode, context: MapContext): string {
    return ['lib', app(context), ...api.module.split('.').slice(0, -1).map(snake), `${snake(lastOf(api.module))}.ex`].join('/');
}

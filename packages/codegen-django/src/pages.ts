import type { MapContext, Step } from '@appling/codegen';
import type { ExprData, GraphNode, TypeData } from '@appling/model';
import { inputLines, pageSizeName, queryCall, queryCode, sourcePath } from './application.js';
import { canName, enforced, fieldGuards, policyImport } from './access.js';
import { children, includeStep, pythonFile, routesStep, task, template } from './files.js';
import { appOf, lastOf, snake } from './python.js';

const CONVERT: { [primitive: string]: string } = { Int: 'int', Decimal: 'Decimal', Money: 'Decimal' };

/**
 * A page becomes a Django view in `pages.py` that collects its components (list, detail, form) for the
 * shared `page.html` template, and a route in the app's `urls.py` at the site root. Row actions and forms
 * post to one runner view per action, which calls the generated action and reports the outcome.
 */
export function pageSteps(page: GraphNode, context: MapContext): Step[] {
    const app = appOf(page.module);
    const imports = new Set(['from django.shortcuts import get_object_or_404, render', 'from django.utils.translation import get_language', `from ${app}.messages import LABELS`]);
    const tasks: Step[] = [];
    const runners: GraphNode[] = [];
    const route = String(page.data.route);
    const byId = route.includes('{id}');
    const lines: string[] = [];
    for (const component of (page.data.components ?? []) as { $type: string, query?: string, projection?: string, picks?: string[], actions?: string[], submits?: string }[]) {
        const actions = (component.actions ?? []).map(qn => context.node(qn)!).filter(action => {
            const ok = !children(action, context, 'Param').some(p => !(p.data.type as TypeData).optional);
            if (!ok) tasks.push(task(`offer ${lastOf(action.qn)} on ${lastOf(page.qn)}; it needs inputs, so it needs a form`));
            return ok;
        });
        runners.push(...actions);
        const buttons = actions.map(a => ({ label: lastOf(a.qn), name: snake(lastOf(a.qn)) }));
        if (component.$type === 'ListView') {
            const query = context.node(component.query!)!;
            // The query's inputs come from the query string of the page.
            const inputs = inputLines(query, ['request.GET'], 'raise BadRequest(inputs.errors)', context, imports);
            if (!queryCode(query, context, new Set()) || !inputs) {
                tasks.push(task(`list ${lastOf(query.qn)} on ${lastOf(page.qn)}`));
                continue;
            }
            if (inputs.length) imports.add('from django.core.exceptions import BadRequest');
            const columns = fields(component.projection!, component.picks, context, tasks, 'row', imports);
            imports.add(`from ${appOf(query.module)}.queries import ${snake(lastOf(query.qn))}${query.data.pageSize ? `, ${pageSizeName(query)}` : ''}`);
            if (query.data.pageSize) imports.add('from django.core.paginator import Paginator');
            lines.push(...context.render('pages/list.py.njk', {
                app,
                inputs,
                query: queryCall(query, 'request.user', context, inputs.length ? ['**inputs.validated_data'] : []),
                pageSize: query.data.pageSize ? pageSizeName(query) : '',
                columns,
                actions: buttons
            }).split('\n'));
        } else if (component.$type === 'DetailView') {
            if (!byId) {
                tasks.push(task(`show ${lastOf(component.projection!)} on ${lastOf(page.qn)}; the route has no {id}`));
                continue;
            }
            const entity = sourceEntity(component.projection!, context);
            imports.add(`from ${appOf(entity.module)}.models import ${lastOf(entity.qn)}`);
            const columns = fields(component.projection!, component.picks, context, tasks, 'record', imports);
            if (enforced(context)) imports.add('from django.core.exceptions import PermissionDenied');
            lines.push(...context.render('pages/detail.py.njk', {
                app,
                model: lastOf(entity.qn),
                readCheck: enforced(context) ? policyImport(entity, canName(entity, 'read'), imports) : '',
                columns,
                actions: buttons
            }).split('\n'));
        } else if (component.$type === 'FormView') {
            const action = context.node(component.submits!)!;
            if (action.kind !== 'Action' || (action.data.entity && !byId)) {
                tasks.push(task(`offer the form ${lastOf(action.qn)} on ${lastOf(page.qn)}`));
                continue;
            }
            runners.push(action);
            const inputs = children(action, context, 'Param').map(p => ({ name: lastOf(p.qn), title: title(lastOf(p.qn)) }));
            lines.push(...context.render('pages/form.py.njk', { app, label: lastOf(action.qn), action: snake(lastOf(action.qn)), byEntity: !!action.data.entity, inputs }).split('\n'));
        }
    }
    const name = snake(lastOf(page.qn));
    const view = context.render('pages/view.py.njk', { name, byId, body: lines, template: `${app}/page.html`, title: title(lastOf(page.qn)) });
    const helpers = context.render('pages/helpers.py.njk', {});
    const base = `${context.render('pages/base.html.njk', {})}\n`;
    return [
        template(`${app}/messages.py`, existing => existing ?? 'LABELS = {}\n'),
        template(`${app}/pages.py`, existing => pythonFile(existing ?? helpers, imports, view)),
        template(`${app}/templates/${app}/base.html`, existing => existing ?? base),
        template(`${app}/templates/${app}/page.html`, () => `${context.render('pages/page.html.njk', { app })}\n`),
        routesStep(app, 'urls', 'pages', [`    path(${JSON.stringify(djangoRoute(route))}, pages.${name}),`], context),
        includeStep(app, 'urls', ''),
        ...[...new Set(runners)].flatMap(action => runnerSteps(action, context)),
        ...tasks
    ];
}

/** One view per action that pages offer: runs the action as the signed in user and reports the outcome. */
function runnerSteps(action: GraphNode, context: MapContext): Step[] {
    const app = appOf(action.module);
    const entity = action.data.entity ? context.node(action.data.entity as string) : undefined;
    const name = snake(lastOf(action.qn));
    const imports = new Set(['from django.contrib import messages', 'from django.shortcuts import redirect', 'from django.views.decorators.http import require_POST', `from ${app}.actions import ${name}`]);
    const errors = children(action, context, 'ErrorDecl').map(e => lastOf(e.qn));
    if (context.graph.nodes.some(n => n.kind === 'Transition' && n.data.action === action.qn)) errors.push('InvalidTransition');
    if (errors.length) imports.add(`from ${app}.errors import ${errors.join(', ')}`);
    if (entity) imports.add(`from ${appOf(entity.module)}.models import ${lastOf(entity.qn)}`);
    const inputs = children(action, context, 'Param').map(p => {
        const type = p.data.type as TypeData;
        const raw = `request.POST.get(${JSON.stringify(lastOf(p.qn))}) or None`;
        const convert = type.primitive && CONVERT[type.primitive];
        if (convert === 'Decimal') imports.add('from decimal import Decimal');
        return `${lastOf(p.qn)}=${convert ? `(lambda v: ${convert}(v) if v else None)(${raw})` : raw}`;
    });
    const instance = entity ? snake(lastOf(entity.qn)) : undefined;
    const view = context.render('pages/runner.py.njk', {
        name,
        instance: instance ?? '',
        model: entity ? lastOf(entity.qn) : '',
        errors,
        label: lastOf(action.qn),
        call: `${name}(${[...(instance ? [instance] : []), ...inputs, 'actor=request.user'].join(', ')})`
    });
    const helpers = context.render('pages/helpers.py.njk', {});
    return [
        template(`${app}/pages.py`, existing => existing?.includes(`def run_${name}(`) ? existing : pythonFile(existing ?? helpers, imports, view)),
        template(`${app}/urls.py`, existing => {
            const line = `    path("_actions/${app}/${name}/${entity ? '<int:id>/' : ''}", pages.run_${name}),`;
            return existing!.includes(line) ? existing! : existing!.replace(/\n\]\n$/, `\n${line}\n]\n`);
        })
    ];
}

/** Navigation becomes the menu of the app's base template; items link to pages that need no id. */
export function navigationSteps(navigation: GraphNode, context: MapContext): Step[] {
    const app = appOf(navigation.module);
    const tasks: Step[] = [];
    const items = (navigation.data.items ?? []) as { label: string, page: string }[];
    const links = items.flatMap(item => {
        const route = String(context.node(item.page)?.data.route ?? '');
        if (route.includes('{')) {
            tasks.push(task(`link ${item.label} in ${lastOf(navigation.qn)}; its page needs an id`));
            return [];
        }
        return [{ route, label: item.label }];
    });
    const nav = context.render('pages/navigation.html.njk', { links });
    return [template(`${app}/templates/${app}/base.html`, existing => (existing ?? `${context.render('pages/base.html.njk', {})}\n`).replace('    <nav>\n', `    <nav>\n${nav}\n`)), ...tasks];
}

/** Message entries become labels for the columns and fields of pages, per language. */
export function messagesSteps(messages: GraphNode, context: MapContext): Step[] {
    const line = context.render('pages/messages.py.njk', { name: lastOf(messages.qn), entries: messages.data.entries ?? [] });
    return [template(`${appOf(messages.module)}/messages.py`, existing => `${(existing ?? 'LABELS = {}\n').trimEnd()}\n${line}\n`)];
}

/** The shown fields of a projection; a field that a read policy guards shows None to actors that may not read it. */
function fields(projectionQn: string, picks: string[] | undefined, context: MapContext, tasks: Step[], record: string, imports: Set<string>): { key: string, title: string, value: string }[] {
    const projection = context.node(projectionQn)!;
    const entity = sourceEntity(projectionQn, context);
    const guards = fieldGuards(entity, context);
    const chosen = picks?.length ? picks.map(p => context.node(p)!) : children(projection, context, 'ProjectionField');
    return chosen.flatMap(field => {
        const path = field.data.value ? sourcePath(field.data.value as ExprData, context) : lastOf(field.qn);
        if (!path) {
            tasks.push(task(`show the computed field ${lastOf(field.qn)} of ${lastOf(projection.qn)} on pages`));
            return [];
        }
        const guard = guards.get(path.split('.')[0]);
        const value = `value(${record}, ${JSON.stringify(path)})`;
        return [{ key: `${lastOf(projection.qn)}.${lastOf(field.qn)}`, title: title(lastOf(field.qn)), value: guard ? `(${value} if ${policyImport(entity, guard, imports)}(request.user, ${record}) else None)` : value }];
    });
}

function sourceEntity(projectionQn: string, context: MapContext): GraphNode {
    const source = context.node(context.node(projectionQn)!.data.source as string)!;
    return source.kind === 'Query' ? context.node(source.data.entity as string)! : source;
}

function djangoRoute(route: string): string {
    return route.replace(/^\//, '').replace(/\{id\}/g, '<int:id>').replace(/\{(\w+)\}/g, '<str:$1>');
}

/** "placed_at" and "OrderDetail" as "Placed at" and "Order detail". */
function title(name: string): string {
    const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
}

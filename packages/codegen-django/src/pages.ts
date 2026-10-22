import type { MapContext, Step } from '@appling/codegen';
import type { ExprData, GraphNode, TypeData } from '@appling/model';
import { pageSizeName, queryCode, sourcePath } from './application.js';
import { children, includeStep, pythonFile, routesStep, task, template } from './files.js';
import { appOf, lastOf, snake } from './python.js';

const HELPERS = `def value(obj, path):
    """Follows a dotted path such as "customer.name"; None when a step is missing."""
    for part in path.split("."):
        obj = getattr(obj, part, None) if obj is not None else None
    return obj


def label(key, default):
    return LABELS.get(get_language()[:2], {}).get(key, default)`;

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
        const buttons = `[${actions.map(a => `{"label": ${JSON.stringify(lastOf(a.qn))}, "url": "/_actions/${app}/${snake(lastOf(a.qn))}/"}`).join(', ')}]`;
        if (component.$type === 'ListView') {
            const query = context.node(component.query!)!;
            if (!queryCode(query, context, new Set())) {
                tasks.push(task(`list ${lastOf(query.qn)} on ${lastOf(page.qn)}`));
                continue;
            }
            const columns = fields(component.projection!, component.picks, context, tasks);
            imports.add(`from ${appOf(query.module)}.queries import ${snake(lastOf(query.qn))}${query.data.pageSize ? `, ${pageSizeName(query)}` : ''}`);
            if (query.data.pageSize) imports.add('from django.core.paginator import Paginator');
            lines.push(
                `rows = ${snake(lastOf(query.qn))}()`,
                ...(query.data.pageSize ? [`rows = Paginator(rows, ${pageSizeName(query)}).get_page(request.GET.get("page"))`] : []),
                'components.append({',
                '    "kind": "list",',
                `    "columns": [${columns.map(c => `label(${JSON.stringify(c.key)}, ${JSON.stringify(c.title)})`).join(', ')}],`,
                `    "items": [{"id": row.pk, "values": [${columns.map(c => `value(row, ${JSON.stringify(c.path)})`).join(', ')}]} for row in rows],`,
                ...(query.data.pageSize ? ['    "page": rows,'] : []),
                `    "actions": ${buttons},`,
                '})'
            );
        } else if (component.$type === 'DetailView') {
            if (!byId) {
                tasks.push(task(`show ${lastOf(component.projection!)} on ${lastOf(page.qn)}; the route has no {id}`));
                continue;
            }
            const entity = sourceEntity(component.projection!, context);
            imports.add(`from ${appOf(entity.module)}.models import ${lastOf(entity.qn)}`);
            const columns = fields(component.projection!, component.picks, context, tasks);
            lines.push(
                `record = get_object_or_404(${lastOf(entity.qn)}, pk=id)`,
                'components.append({',
                '    "kind": "detail",',
                '    "id": record.pk,',
                `    "fields": [${columns.map(c => `(label(${JSON.stringify(c.key)}, ${JSON.stringify(c.title)}), value(record, ${JSON.stringify(c.path)}))`).join(', ')}],`,
                `    "actions": ${buttons},`,
                '})'
            );
        } else if (component.$type === 'FormView') {
            const action = context.node(component.submits!)!;
            if (action.kind !== 'Action' || (action.data.entity && !byId)) {
                tasks.push(task(`offer the form ${lastOf(action.qn)} on ${lastOf(page.qn)}`));
                continue;
            }
            runners.push(action);
            const inputs = children(action, context, 'Param').map(p => `(${JSON.stringify(lastOf(p.qn))}, ${JSON.stringify(title(lastOf(p.qn)))})`);
            lines.push(
                'components.append({',
                '    "kind": "form",',
                `    "label": ${JSON.stringify(lastOf(action.qn))},`,
                `    "url": "/_actions/${app}/${snake(lastOf(action.qn))}/"${action.data.entity ? ' + str(id) + "/"' : ''},`,
                `    "inputs": [${inputs.join(', ')}],`,
                '})'
            );
        }
    }
    const name = snake(lastOf(page.qn));
    const view = [
        `def ${name}(request${byId ? ', id' : ''}):`,
        '    components = []',
        ...lines.map(l => `    ${l}`),
        `    return render(request, ${JSON.stringify(`${app}/page.html`)}, {"title": ${JSON.stringify(title(lastOf(page.qn)))}, "components": components})`
    ].join('\n');
    return [
        template(`${app}/messages.py`, existing => existing ?? 'LABELS = {}\n'),
        template(`${app}/pages.py`, existing => pythonFile(existing ?? HELPERS, imports, view)),
        template(`${app}/templates/${app}/base.html`, existing => existing ?? BASE),
        template(`${app}/templates/${app}/page.html`, () => PAGE.replaceAll('{app}', app)),
        routesStep(app, 'urls', 'pages', [`    path(${JSON.stringify(djangoRoute(route))}, pages.${name}),`]),
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
    const call = `${name}(${[...(instance ? [instance] : []), ...inputs, 'actor=request.user'].join(', ')})`;
    const view = [
        '@require_POST',
        `def run_${name}(request${entity ? ', id' : ''}):`,
        ...(entity ? [`    ${instance} = get_object_or_404(${lastOf(entity.qn)}, pk=id)`] : []),
        ...(errors.length
            ? ['    try:', `        ${call}`, `        messages.success(request, ${JSON.stringify(`${lastOf(action.qn)} done.`)})`, `    except (${errors.join(', ')}${errors.length === 1 ? ',' : ''}) as error:`, `        messages.error(request, ${JSON.stringify(`${lastOf(action.qn)} failed: `)} + type(error).__name__)`]
            : [`    ${call}`, `    messages.success(request, ${JSON.stringify(`${lastOf(action.qn)} done.`)})`]),
        '    return redirect(request.POST.get("next") or "/")'
    ].join('\n');
    return [
        template(`${app}/pages.py`, existing => existing?.includes(`def run_${name}(`) ? existing : pythonFile(existing ?? HELPERS, imports, view)),
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
        return [`      <a href="${route}">${item.label}</a>`];
    });
    return [template(`${app}/templates/${app}/base.html`, existing => (existing ?? BASE).replace('    <nav>\n', `    <nav>\n${links.join('\n')}\n`)), ...tasks];
}

/** Message entries become labels for the columns and fields of pages, per language. */
export function messagesSteps(messages: GraphNode): Step[] {
    const entries = (messages.data.entries ?? []) as { key: string, text: string }[];
    const dict = `{${entries.map(e => `${JSON.stringify(e.key)}: ${JSON.stringify(e.text)}`).join(', ')}}`;
    return [template(`${appOf(messages.module)}/messages.py`, existing => `${(existing ?? 'LABELS = {}\n').trimEnd()}\nLABELS[${JSON.stringify(lastOf(messages.qn))}] = ${dict}\n`)];
}

function fields(projectionQn: string, picks: string[] | undefined, context: MapContext, tasks: Step[]): { key: string, title: string, path: string }[] {
    const projection = context.node(projectionQn)!;
    const chosen = picks?.length ? picks.map(p => context.node(p)!) : children(projection, context, 'ProjectionField');
    return chosen.flatMap(field => {
        const path = field.data.value ? sourcePath(field.data.value as ExprData, context) : lastOf(field.qn);
        if (!path) {
            tasks.push(task(`show the computed field ${lastOf(field.qn)} of ${lastOf(projection.qn)} on pages`));
            return [];
        }
        return [{ key: `${lastOf(projection.qn)}.${lastOf(field.qn)}`, title: title(lastOf(field.qn)), path }];
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

const BASE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>{% block title %}{{ title }}{% endblock %}</title>
  </head>
  <body>
    <nav>
    </nav>
    {% for message in messages %}<p class="message {{ message.tags }}">{{ message }}</p>{% endfor %}
    <main>
      {% block content %}{% endblock %}
    </main>
  </body>
</html>
`;

const PAGE = `{% extends "{app}/base.html" %}
{% block content %}
<h1>{{ title }}</h1>
{% for component in components %}
  {% if component.kind == "list" %}
    <table>
      <thead><tr>{% for column in component.columns %}<th>{{ column }}</th>{% endfor %}<th></th></tr></thead>
      <tbody>
        {% for item in component.items %}
          <tr>
            {% for value in item.values %}<td>{{ value|default_if_none:"" }}</td>{% endfor %}
            <td>{% for action in component.actions %}<form method="post" action="{{ action.url }}{{ item.id }}/">{% csrf_token %}<input type="hidden" name="next" value="{{ request.path }}"><button>{{ action.label }}</button></form>{% endfor %}</td>
          </tr>
        {% empty %}
          <tr><td>Nothing here yet.</td></tr>
        {% endfor %}
      </tbody>
    </table>
    {% if component.page.has_other_pages %}
      <p>
        {% if component.page.has_previous %}<a href="?page={{ component.page.previous_page_number }}">Previous</a>{% endif %}
        {% if component.page.has_next %}<a href="?page={{ component.page.next_page_number }}">Next</a>{% endif %}
      </p>
    {% endif %}
  {% elif component.kind == "detail" %}
    <dl>{% for name, value in component.fields %}<dt>{{ name }}</dt><dd>{{ value|default_if_none:"" }}</dd>{% endfor %}</dl>
    {% for action in component.actions %}<form method="post" action="{{ action.url }}{{ component.id }}/">{% csrf_token %}<input type="hidden" name="next" value="{{ request.path }}"><button>{{ action.label }}</button></form>{% endfor %}
  {% elif component.kind == "form" %}
    <form method="post" action="{{ component.url }}">
      {% csrf_token %}
      <input type="hidden" name="next" value="{{ request.path }}">
      {% for name, field_label in component.inputs %}<label>{{ field_label }} <input name="{{ name }}"></label>{% endfor %}
      <button>{{ component.label }}</button>
    </form>
  {% endif %}
{% endfor %}
{% endblock %}
`;

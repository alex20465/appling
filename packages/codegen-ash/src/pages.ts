import type { MapContext, Step } from '@appling/codegen';
import type { ExprData, GraphNode, TypeData } from '@appling/model';
import { ashExpr, lastOf } from './elixir.js';
import { app, calculation, children, pascal, patch, snake, task, typeModule, TYPES } from './naming.js';

interface Column {
    label: string;
    field: string;
    load?: boolean;
}

/** Whether the model has pages, which makes the generated project a Phoenix application. */
export function hasPages(context: MapContext): boolean {
    return context.graph.nodes.some(n => n.kind === 'Page');
}

export function web(context: MapContext): string {
    return `${pascal(app(context))}Web`;
}

/**
 * A page becomes a LiveView: lists read through the query's read action into a `.table`, details load
 * the record of the route's `:id` into a `.list`, forms are AshPhoenix forms for the action. Row actions
 * and forms run the action and report the outcome as a flash.
 */
export function pageSteps(page: GraphNode, context: MapContext): Step[] {
    const tasks: Step[] = [];
    const name = `${lastOf(page.qn)}Live`;
    const route = String(page.data.route).replace(/\{(\w+)\}/g, ':$1');
    const byId = route.includes(':id');
    const assigns: string[] = [];
    const markup: string[] = [];
    const events = new Map<string, string>();
    (page.data.components as { $type: string, query?: string, projection?: string, picks?: string[], actions?: string[], submits?: string }[]).forEach((component, i) => {
        const id = `${component.$type === 'ListView' ? 'list' : component.$type === 'DetailView' ? 'record' : 'form'}_${i + 1}`;
        const actions = (component.actions ?? []).map(qn => context.node(qn)!).filter(action => {
            const ok = !!action.data.entity && !children(action, context, 'Param').some(p => !(p.data.type as TypeData).optional);
            if (!ok) tasks.push(task(`offer ${lastOf(action.qn)} on ${lastOf(page.qn)}; it needs inputs, so it needs a form`));
            return ok;
        });
        for (const action of actions) events.set(`run_${snake(lastOf(action.qn))}`, runEvent(action, context));
        const buttons = (record: string) => actions.map(a => `<.button phx-click="run_${snake(lastOf(a.qn))}" phx-value-id={${record}.id}>${lastOf(a.qn)}</.button>`).join(' ');
        if (component.$type === 'ListView') {
            const query = context.node(component.query!)!;
            const entity = context.node(query.data.entity as string)!;
            const columns = columnsOf(component.projection!, component.picks, context, tasks);
            const load = columns.filter(c => c.load).map(c => `:${c.field}`);
            const read = `Ash.read!(${typeModule(entity, context)}, action: :${snake(lastOf(query.qn))}${load.length ? `, load: [${load.join(', ')}]` : ''}${query.data.pageSize ? `, page: [limit: ${query.data.pageSize}]` : ''})`;
            assigns.push(`|> assign(:${id}, ${query.data.pageSize ? `${read}.results` : read})`);
            markup.push(
                `<.table id="${id.replace('_', '-')}" rows={@${id}}>`,
                ...columns.map(c => `  <:col :let={row} label=${JSON.stringify(c.label)}>{to_string(row.${c.field})}</:col>`),
                ...(actions.length ? [`  <:action :let={row}>${buttons('row')}</:action>`] : []),
                '</.table>'
            );
        } else if (component.$type === 'DetailView') {
            if (!byId) {
                tasks.push(task(`show ${lastOf(component.projection!)} on ${lastOf(page.qn)}; the route has no :id`));
                return;
            }
            const entity = sourceEntity(component.projection!, context);
            const columns = columnsOf(component.projection!, component.picks, context, tasks);
            const load = columns.filter(c => c.load).map(c => `:${c.field}`);
            assigns.push(`|> assign(:${id}, Ash.get!(${typeModule(entity, context)}, socket.assigns.id${load.length ? `, load: [${load.join(', ')}]` : ''}))`);
            markup.push('<.list>', ...columns.map(c => `  <:item title=${JSON.stringify(c.label)}>{to_string(@${id}.${c.field})}</:item>`), '</.list>', ...(actions.length ? [buttons(`@${id}`)] : []));
        } else if (component.$type === 'FormView') {
            const action = context.node(component.submits!)!;
            const entity = action.kind === 'Action' && action.data.entity ? context.node(action.data.entity as string) : undefined;
            if (!entity || !byId) {
                tasks.push(task(`offer the form ${lastOf(action.qn)} on ${lastOf(page.qn)}`));
                return;
            }
            const event = `submit_${snake(lastOf(action.qn))}`;
            assigns.push(`|> assign(:${id}, AshPhoenix.Form.for_update(Ash.get!(${typeModule(entity, context)}, socket.assigns.id), :${snake(lastOf(action.qn))}) |> to_form())`);
            events.set(event, [
                `def handle_event("${event}", %{"form" => params}, socket) do`,
                `  case AshPhoenix.Form.submit(socket.assigns.${id}, params: params) do`,
                `    {:ok, _} -> {:noreply, socket |> put_flash(:info, ${JSON.stringify(`${lastOf(action.qn)} done.`)}) |> load()}`,
                `    {:error, form} -> {:noreply, assign(socket, :${id}, form)}`,
                '  end',
                'end'
            ].join('\n'));
            markup.push(
                `<.form for={@${id}} phx-submit="${event}">`,
                ...children(action, context, 'Param').map(p => `  <.input field={@${id}[:${lastOf(p.qn)}]} label=${JSON.stringify(title(lastOf(p.qn)))} />`),
                `  <.button>${lastOf(action.qn)}</.button>`,
                '</.form>'
            );
        }
    });
    const nav = navigationLinks(page.module, context);
    const code = [
        `defmodule ${web(context)}.${name} do`,
        `  use ${web(context)}, :live_view`,
        '',
        '  @impl true',
        `  def mount(${byId ? '%{"id" => id}' : '_params'}, _session, socket) do`,
        `    {:ok, socket |> assign(:page_title, ${JSON.stringify(title(lastOf(page.qn)))})${byId ? ' |> assign(:id, id)' : ''} |> load()}`,
        '  end',
        '',
        '  defp load(socket) do',
        '    socket',
        ...assigns.map(a => `    ${a}`),
        '  end',
        ...[...events.values()].flatMap(handler => ['', '  @impl true', ...handler.split('\n').map(l => `  ${l}`)]),
        '',
        '  @impl true',
        '  def render(assigns) do',
        '    ~H"""',
        '    <Layouts.app flash={@flash}>',
        ...(nav ? [`      ${nav}`] : []),
        `      <.header>${title(lastOf(page.qn))}</.header>`,
        ...markup.map(l => `      ${l}`),
        '    </Layouts.app>',
        '    """',
        '  end',
        'end',
        ''
    ].join('\n');
    return [
        { kind: 'template', file: `lib/${app(context)}_web/live/${snake(lastOf(page.qn))}_live.ex`, write: () => code, phase: 2 },
        patch(`lib/${app(context)}_web/router.ex`, existing => existing.includes(`live "${route}", ${name}`) ? existing
            : existing.replace(/(\n(\s*)get "\/", PageController, :home\n)/, `$1$2live "${route}", ${name}\n`)),
        ...tasks
    ];
}

function runEvent(action: GraphNode, context: MapContext): string {
    const entity = context.node(action.data.entity as string)!;
    return [
        `def handle_event("run_${snake(lastOf(action.qn))}", %{"id" => id}, socket) do`,
        `  case Ash.update(Ash.get!(${typeModule(entity, context)}, id), %{}, action: :${snake(lastOf(action.qn))}) do`,
        `    {:ok, _} -> {:noreply, socket |> put_flash(:info, ${JSON.stringify(`${lastOf(action.qn)} done.`)}) |> load()}`,
        `    {:error, error} -> {:noreply, put_flash(socket, :error, ${JSON.stringify(`${lastOf(action.qn)} failed: `)} <> Exception.message(error))}`,
        '  end',
        'end'
    ].join('\n');
}

/** The navigation of the module as links; items to pages that need an id are left out. */
function navigationLinks(module: string, context: MapContext): string | undefined {
    const items = context.graph.nodes.filter(n => n.kind === 'Navigation' && n.module === module).flatMap(n => (n.data.items ?? []) as { label: string, page: string }[]);
    const links = items.filter(i => !String(context.node(i.page)?.data.route ?? '').includes('{')).map(i => `<.link navigate="${context.node(i.page)!.data.route}">${i.label}</.link>`);
    return links.length ? `<nav class="flex gap-4 mb-6">${links.join(' ')}</nav>` : undefined;
}

export function navigationSteps(navigation: GraphNode, context: MapContext): Step[] {
    return ((navigation.data.items ?? []) as { label: string, page: string }[])
        .filter(i => String(context.node(i.page)?.data.route ?? '').includes('{'))
        .map(i => task(`link ${i.label} in ${lastOf(navigation.qn)}; its page needs an id`));
}

/** Projection fields as columns: stored attributes as they are, derived and computed fields through their calculations. */
function columnsOf(projectionQn: string, picks: string[] | undefined, context: MapContext, tasks: Step[]): Column[] {
    const projection = context.node(projectionQn)!;
    const entity = sourceEntity(projectionQn, context);
    const fields = new Map(children(entity, context, 'Field').map(f => [lastOf(f.qn), f]));
    const chosen = picks?.length ? picks.map(p => context.node(p)!) : children(projection, context, 'ProjectionField');
    return chosen.flatMap(field => {
        const name = lastOf(field.qn);
        const label = labelOf(projection, name, context);
        const value = field.data.value as ExprData | undefined;
        if (value) {
            if (ashExpr(value, context.node) && TYPES[value.type.replace(/\?$/, '')]) return [{ label, field: name, load: true }];
        } else {
            const source = fields.get(name);
            if (source && !source.data.derived) return [{ label, field: name }];
            if (source && calculation(source, context)) return [{ label, field: name, load: true }];
        }
        tasks.push(task(`show ${name} of ${lastOf(projection.qn)} on pages`));
        return [];
    });
}

function labelOf(projection: GraphNode, field: string, context: MapContext): string {
    const key = `${lastOf(projection.qn)}.${field}`;
    for (const messages of context.graph.nodes.filter(n => n.kind === 'Messages' && n.module === projection.module)) {
        const entry = ((messages.data.entries ?? []) as { key: string, text: string }[]).find(e => e.key === key);
        if (entry) return entry.text;
    }
    return title(field);
}

function sourceEntity(projectionQn: string, context: MapContext): GraphNode {
    const source = context.node(context.node(projectionQn)!.data.source as string)!;
    return source.kind === 'Query' ? context.node(source.data.entity as string)! : source;
}

function title(name: string): string {
    const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
}

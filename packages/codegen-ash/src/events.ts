import type { MapContext, Step } from '@appling/codegen';
import type { ExprData, GraphNode, TypeData } from '@appling/model';
import { constant, lastOf, withModuledoc } from './elixir.js';
import { app, fieldsOf, fileOf, snake, storedAttributes, typeModule } from './naming.js';

/**
 * An event becomes a struct module with `publish/1`, which fires a `:telemetry` event named `name/0` with the struct
 * as metadata `:event`. Handlers subscribe with `:telemetry.attach/4`; they run in the publishing process, the way
 * Django's signals do.
 */
export function eventSteps(event: GraphNode, context: MapContext): Step[] {
    return [{ kind: 'template', file: fileOf(event, context), write: () => eventModule(event, context) }];
}

function eventModule(event: GraphNode, context: MapContext): string {
    const fields = fieldsOf(event, context).filter(f => !f.data.derived);
    const required = fields.filter(f => !(f.data.type as TypeData).optional && !(f.data.type as TypeData).many);
    const name = [app(context), ...event.module.split('.').map(snake), snake(lastOf(event.qn))].map(part => `:${part}`).join(', ');
    return withModuledoc([
        `defmodule ${typeModule(event, context)} do`,
        ...(required.length ? [`  @enforce_keys [${required.map(f => `:${lastOf(f.qn)}`).join(', ')}]`] : []),
        `  defstruct [${fields.map(f => `:${lastOf(f.qn)}`).join(', ')}]`,
        '',
        '  @doc "The telemetry event name handlers attach to."',
        `  def name, do: [${name}]`,
        '',
        '  @doc "Runs the handlers attached to `name/0`, with the event as metadata `:event`."',
        '  def publish(%__MODULE__{} = event), do: :telemetry.execute(name(), %{}, %{event: event})',
        'end',
        ''
    ].join('\n'), event);
}

/**
 * `emit E { field = value }` in an action as an `after_transaction` change that publishes the event once the action
 * committed. Values may be `this`, a stored attribute of the record (`this.total`, `total`), an action input or a
 * constant; anything else, or a required field without a value, leaves the effect to a task.
 */
export function emitChange(effect: GraphNode, entity: GraphNode, context: MapContext): string[] | undefined {
    const event = context.node(effect.data.event as string);
    if (!event) return undefined;
    const given = new Map(((effect.data.assignments ?? []) as { name: string, value: ExprData }[]).map(a => [a.name, a.value]));
    const stored = storedAttributes(entity, context);
    const values: string[] = [];
    let usesChangeset = false;
    for (const field of fieldsOf(event, context).filter(f => !f.data.derived)) {
        const type = field.data.type as TypeData;
        const expr = given.get(lastOf(field.qn));
        if (!expr) {
            if (!type.optional && !type.many) return undefined;
            continue;
        }
        const value = elixirValue(expr, stored, context);
        if (!value) return undefined;
        usesChangeset ||= value.includes('changeset');
        values.push(`${lastOf(field.qn)}: ${value}`);
    }
    const module = typeModule(event, context);
    return [
        'after_transaction(fn',
        `  ${usesChangeset ? 'changeset' : '_changeset'}, {:ok, record}, _context ->`,
        `    ${module}.publish(%${module}{${values.join(', ')}})`,
        '    {:ok, record}',
        '',
        '  _changeset, result, _context ->',
        '    result',
        'end)'
    ];
}

function elixirValue(expr: ExprData, stored: Set<string>, context: MapContext): string | undefined {
    if (expr.$type === 'NameExpr' && !expr.call) {
        if (expr.name === 'this' && !expr.target) return 'record';
        const target = expr.target ? context.node(expr.target) : undefined;
        if (target?.kind === 'Param') return `Ash.Changeset.get_argument(changeset, :${expr.name})`;
        if (target && stored.has(target.qn)) return `record.${expr.name}`;
    }
    if (expr.$type === 'MemberExpr' && !expr.call && expr.receiver?.$type === 'NameExpr' && expr.receiver.name === 'this' && !expr.receiver.target) {
        const target = expr.target ? context.node(expr.target) : undefined;
        if (target && stored.has(target.qn)) return `record.${expr.member}`;
    }
    return constant(expr, context.node);
}

import type { MapContext, Step } from '@appling/codegen';
import type { ExprData, GraphNode, TypeData } from '@appling/model';
import { constant, elixirString, isActor, lastOf, parentOf } from './elixir.js';
import { children, fieldsOf, moduleName, relationTarget, snake, task, typeModule, app } from './naming.js';
import { partitionOf } from './tenants.js';

interface Call {
    target: string;
    /** Left out by the graph when the call has no arguments. */
    args?: ExprData[];
}

interface UseCaseStep {
    $type: string;
    call?: Call;
    handlers?: { error: string, call: Call }[];
    event?: string;
    timeout?: string;
}

/** The file of a module's use cases, `lib/<app>/<module>/use_cases.ex`. */
export function useCaseFile(moduleQn: string, context: MapContext): string {
    return ['lib', app(context), ...moduleQn.split('.').map(snake), 'use_cases.ex'].join('/');
}

/**
 * A use case becomes a function of its module's `<Domain>.UseCases`, which runs its steps in order: an action on a
 * record as `Ash.update!` (or `Ash.destroy!`) with the action's name, a query as `Ash.read!` of its read action, an
 * external operation through the client module given in the options (`payments: MyPayments`), whose functions answer
 * `{:error, :declined}` for the declared errors the step handles, and another use case with the same options. The
 * options carry `actor` and `tenant` too. The steps from the first one that does not translate on, an `await`
 * included, stay registry tasks.
 */
export function useCaseSteps(useCase: GraphNode, context: MapContext): Step[] {
    const { code, tasks } = useCaseCode(useCase, context);
    const module = `${moduleName(useCase.module, context)}.UseCases`;
    return [
        {
            kind: 'template', file: useCaseFile(useCase.module, context), phase: 2,
            write: existing => existing ? existing.replace(/end\n?$/, `\n${code}end\n`) : `defmodule ${module} do\n${code}end\n`
        },
        ...tasks
    ];
}

/** One statement of the function body, with the record it rebinds, if any. */
interface Line {
    code: string[];
    binds?: string;
}

export function useCaseCode(useCase: GraphNode, context: MapContext): { code: string, tasks: Step[] } {
    const name = lastOf(useCase.qn);
    const params = children(useCase, context, 'Param');
    const scope: Scope = { context, module: useCase.module, params: new Set(params.map(p => p.qn)), externals: new Map(), tenant: false };
    const lines: Line[] = [];
    const tasks: Step[] = [];
    for (const step of (useCase.data.steps ?? []) as UseCaseStep[]) {
        if (step.$type === 'AwaitStep') {
            tasks.push(task(`continue ${name} when ${lastOf(step.event!)} happens${step.timeout ? `, or after ${step.timeout} with the timeout call` : ''}; the steps from here on are not generated`));
            break;
        }
        const target = context.node(step.call!.target)!;
        const call = callCode(step.call!, scope);
        if (!call || (step.handlers?.length && target.kind !== 'ExternalOperation')) {
            tasks.push(task(`call ${lastOf(step.call!.target)} in ${name}${call ? ' and handle its errors' : ''}; the steps from here on are not generated`));
            break;
        }
        if (!step.handlers?.length) {
            lines.push({ code: [call.code], binds: call.binds });
            continue;
        }
        // An external operation answers {:error, :reason} for a declared error; a handled one runs its recovery.
        const clauses: string[] = [];
        for (const handler of step.handlers) {
            const recovery = callCode(handler.call, scope);
            const reason = `{:error, :${snake(lastOf(handler.error))}}`;
            if (recovery) clauses.push(`  ${reason} -> ${recovery.code}`);
            else tasks.push(task(`recover from ${lastOf(handler.error)} with ${lastOf(handler.call.target)} in ${name}`));
        }
        lines.push({ code: [`case ${call.code} do`, ...clauses, '  result -> result', 'end'] });
    }
    // A record is rebound to what its action returns only when a later step reads it, else Elixir warns.
    const body = lines.flatMap((line, i) => {
        const later = lines.slice(i + 1).flatMap(l => l.code).join('\n');
        const bind = line.binds && new RegExp(`\\b${line.binds}\\b`).test(later) ? `${line.binds} = ` : '';
        return [bind + line.code[0], ...line.code.slice(1)];
    });
    const text = body.join('\n');
    const uses = (variable: string) => new RegExp(`\\b${variable}\\b`).test(text);
    const options = [
        ...(uses('actor') ? ['actor = Keyword.get(opts, :actor)'] : []),
        ...(uses('tenant') ? ['tenant = Keyword.get(opts, :tenant)'] : []),
        ...[...scope.externals.values()].filter(uses).map(variable => `${variable} = Keyword.fetch!(opts, :${variable})`)
    ];
    const optsUsed = options.length > 0 || uses('opts');
    const signature = [...params.map(p => `${uses(snake(lastOf(p.qn))) ? '' : '_'}${snake(lastOf(p.qn))}`), `${optsUsed ? '' : '_'}opts \\\\ []`];
    const statements = [...options, ...body, ':ok'];
    const doc = typeof useCase.data.does === 'string' && useCase.data.does.trim() ? `  @doc ${elixirString(useCase.data.does.trim())}\n` : '';
    const code = `${doc}  def ${snake(name)}(${signature.join(', ')}) do\n${statements.map(l => `    ${l}\n`).join('')}  end\n`;
    return { code, tasks };
}

interface Scope {
    context: MapContext;
    /** The use case's module. */
    module: string;
    /** The qualified names of the use case's inputs. */
    params: Set<string>;
    /** The external systems called, by qualified name, with their variable. */
    externals: Map<string, string>;
    tenant: boolean;
}

function callCode(call: Call, scope: Scope): { code: string, binds?: string } | undefined {
    const { context } = scope;
    const target = context.node(call.target)!;
    const args = call.args ?? [];
    if (target.kind === 'Action') {
        const entity = target.data.entity ? context.node(target.data.entity as string) : undefined;
        // Actions without a record are not generated in Ash yet (their own registry task).
        const record = entity && args[0] && recordVariable(args[0], scope);
        if (!entity || !record) return undefined;
        const inputs = children(target, context, 'Param').map((param, i) => {
            const arg = args[i + 1];
            if (!arg) return '';
            // A record input has no generated argument to take it.
            if (relationTarget(param, context)) return undefined;
            const value = valueCode(arg, scope);
            return value && `${lastOf(param.qn)}: ${value}`;
        });
        if (inputs.some(i => i === undefined)) return undefined;
        const destroy = !context.graph.nodes.some(n => n.kind === 'Transition' && n.data.action === target.qn)
            && children(target, context).some(c => c.kind === 'DeleteEffect' && c.data.self);
        const options = [`action: :${snake(lastOf(target.qn))}`, 'actor: actor', ...tenantOption(entity, scope)];
        const map = `%{${inputs.filter(Boolean).join(', ')}}`;
        return destroy
            ? { code: `Ash.destroy!(${record}, ${options.join(', ')})` }
            : { code: `Ash.update!(${record}, ${map}, ${options.join(', ')})`, binds: record };
    }
    if (target.kind === 'Query') {
        const entity = context.node(target.data.entity as string)!;
        const inputs = children(target, context, 'Param').map((param, i) => {
            const arg = args[i];
            if (!arg) return '';
            // A query input that names a record takes its id.
            const value = relationTarget(param, context) ? idCode(arg, scope) : valueCode(arg, scope);
            return value && `${lastOf(param.qn)}: ${value}`;
        });
        if (inputs.some(i => i === undefined)) return undefined;
        const options = ['actor: actor', ...tenantOption(entity, scope)];
        return { code: `Ash.read!(Ash.Query.for_read(${typeModule(entity, context)}, :${snake(lastOf(target.qn))}, %{${inputs.filter(Boolean).join(', ')}}, ${options.join(', ')}))` };
    }
    if (target.kind === 'ExternalOperation') {
        const external = context.node(parentOf(target.qn))!;
        const values = args.map(a => valueCode(a, scope));
        if (values.some(v => v === undefined)) return undefined;
        const variable = snake(lastOf(external.qn));
        scope.externals.set(external.qn, variable);
        return { code: `${variable}.${snake(lastOf(target.qn))}(${values.join(', ')})` };
    }
    if (target.kind === 'UseCase') {
        const values = args.map(a => recordVariable(a, scope) ?? valueCode(a, scope));
        if (values.some(v => v === undefined)) return undefined;
        const fn = target.module === scope.module ? snake(lastOf(target.qn)) : `${moduleName(target.module, context)}.UseCases.${snake(lastOf(target.qn))}`;
        return { code: `${fn}(${[...values, 'opts'].join(', ')})` };
    }
    return undefined;
}

function tenantOption(entity: GraphNode, scope: Scope): string[] {
    if (!partitionOf(entity, scope.context)) return [];
    scope.tenant = true;
    return ['tenant: tenant'];
}

/** An input of the use case that holds a record, as its variable. */
function recordVariable(expr: ExprData, scope: Scope): string | undefined {
    if (expr.$type !== 'NameExpr' || expr.call || !expr.target || !scope.params.has(expr.target)) return undefined;
    const param = scope.context.node(expr.target)!;
    return relationTarget(param, scope.context) ? snake(expr.name!) : undefined;
}

/** The id of a record: `order.id` for an input, `order.buyer_id` for a relationship of one. */
function idCode(expr: ExprData, scope: Scope): string | undefined {
    const record = recordVariable(expr, scope);
    if (record) return `${record}.id`;
    if (expr.$type === 'MemberExpr' && !expr.call && expr.target) {
        const field = scope.context.node(expr.target);
        const receiver = recordVariable(expr.receiver!, scope);
        if (field && receiver && relationTarget(field, scope.context) && !(field.data.type as TypeData).many) return `${receiver}.${expr.member}_id`;
    }
    return undefined;
}

/** A plain value: a literal, `now`, an input that is no record, a stored attribute of a record input, or the actor. */
function valueCode(expr: ExprData, scope: Scope): string | undefined {
    const literal = constant(expr, scope.context.node);
    if (literal !== undefined) return literal;
    if (isActor(expr)) return 'actor';
    if (expr.$type === 'NameExpr' && !expr.call) {
        if (expr.name === 'now' && !expr.target) return 'DateTime.utc_now()';
        if (expr.target && scope.params.has(expr.target) && !relationTarget(scope.context.node(expr.target)!, scope.context)) return snake(expr.name!);
        return undefined;
    }
    if (expr.$type === 'MemberExpr' && !expr.call && expr.target) {
        const field = scope.context.node(expr.target);
        const receiver = recordVariable(expr.receiver!, scope);
        if (!field || !receiver || field.kind !== 'Field') return undefined;
        const owner = scope.context.node(parentOf(field.qn))!;
        const stored = fieldsOf(owner, scope.context).some(f => f.qn === field.qn && !f.data.derived && !relationTarget(f, scope.context));
        return stored ? `${receiver}.${expr.member}` : undefined;
    }
    return undefined;
}

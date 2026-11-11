import type { CodegenExtension, MapContext, Step } from '@appling/codegen';
import { coveredByScenarios, scenarioCall, Simulator, throughPath, UNKNOWN, type ExprData, type Graph, type GraphNode, type Record as SimRecord, type TypeData, type Value } from '@appling/model';
import { accessFile, accessOf, accessSteps, actorFields, actorFieldType, tenantOf, tenantPaths } from './access.js';
import { camel, enumConstant, goExpr, goTerm, pascal, PRIMITIVES, qualify, type GoScope } from './golang.js';
import { GOOSE, GOOSE_VERSION, migrationSteps, PGX, PGX_VERSION, storageSteps, stores as hasEntities, type Helpers } from './storage.js';

const DECIMAL = 'github.com/shopspring/decimal';
const OPERATIONS = ['read', 'create', 'update', 'delete'];

const extension: CodegenExtension = {
    name: '@appling/codegen-go',
    test: ['go', 'test', './...'],
    syncExclude: ['go.sum'],
    prerequisites: [{ name: 'Go', command: ['go', 'version'], expect: /go1\.(2[5-9]|[3-9]\d)/, hint: 'install Go 1.25 or later' }],

    setup: context => [
        { kind: 'command', run: ['go', 'mod', 'init', context.name], creates: ['go.mod'] },
        { kind: 'command', run: ['go', 'get', `${DECIMAL}@v1.6.0`], creates: ['go.sum'] },
        // The storage package's imports, by package so go.sum gets every module they need.
        ...(hasEntities(context) ? [{ kind: 'command' as const, run: ['go', 'get', ...['pgxpool', 'stdlib'].map(p => `${PGX}/${p}@${PGX_VERSION}`), `${GOOSE}@${GOOSE_VERSION}`] }] : []),
        { kind: 'command', run: ['gofmt', '-w', '.'], phase: 3 }
    ],

    migrate: (change, context) => migrationSteps(change, context),

    steps(node, context) {
        switch (node.kind) {
            case 'Module': return [
                goFile(node.qn, 'doc.go', context, new Set(), `// Package ${pkgOf(node.qn)} holds the ${node.qn} module of the model.`),
                goFile(node.qn, 'support.go', context, new Set(), '// ptr returns a pointer to a copy of v, for optional fields.\nfunc ptr[T any](v T) *T { return &v }')
            ];
            case 'Enum': return [enumSteps(node, context)];
            case 'ValueType': return [structStep(node, context, 'types.go')];
            case 'Entity': return entitySteps(node, context);
            case 'Event': return [structStep(node, context, 'events.go')];
            case 'ErrorDecl': return [goFile(node.module, 'errors.go', context, new Set(['errors']), `// ${errorName(node)} is the declared error ${node.qn}.\nvar ${errorName(node)} = errors.New(${JSON.stringify(last(node.qn))})`)];
            case 'Field': return fieldSteps(node, context);
            case 'Invariant': return [...(validation(node, context) ? [] : [task(`check the invariant "${node.data.label}" in Validate: ${node.props.condition}`)]), ...invariantTestSteps(node, context)];
            case 'Policy': return [...policySteps(node, context), ...policyTestSteps(node, context)];
            case 'Role':
            case 'Actor':
            case 'Tenant':
                return accessSteps(node, context);
            case 'Action': return actionSteps(node, context);
            case 'Machine': return machineSteps(node, context);
            case 'Transition': return covered(context).has(node.qn) ? [] : transitionTestSteps(node, context);
            case 'Scenario': return scenarioSteps(node, context);
            case 'EnumLiteral':
            case 'Param':
            case 'SetEffect':
            case 'CreateEffect':
            case 'EmitEffect':
            case 'ForEffect':
            case 'UpdateEffect':
            case 'DeleteEffect':
            case 'ExternalOperation':
            case 'ProjectionField':
            case 'Endpoint':
                return [];
            case 'Query': return [...guardSteps(node, context), ...queryFilterSteps(node, context), task(`implement the query ${last(node.qn)} on top of the generated domain package, with the storage, HTTP and scheduling libraries of your choice`)];
            case 'UseCase':
                return [...guardSteps(node, context), task(`implement the use case ${last(node.qn)} on top of the generated domain package, with the storage, HTTP and scheduling libraries of your choice`)];
            case 'External':
                return [leftToCode(`implement a client for ${last(node.qn)} with the HTTP library of your choice`)];
            case 'Job':
            case 'Projection':
            case 'Interface':
            case 'Page':
            case 'Navigation':
            case 'Flow':
            case 'Messages':
                return [task(`implement the ${node.kind.toLowerCase()} ${last(node.qn)} on top of the generated domain package, with the storage, HTTP and scheduling libraries of your choice`)];
            default: return undefined;
        }
    }
};

export default extension;

/** What the storage generator shares with the domain generator. */
const HELPERS: Helpers = { fieldsOf, goFile, goScope, typeOf, validRecord };

function enumSteps(node: GraphNode, context: MapContext): Step {
    const name = last(node.qn);
    const values = context.children(node.qn).map(l => `\t${name}${pascal(last(l.qn))} ${name} = ${JSON.stringify(last(l.qn))}`);
    return goFile(node.module, 'types.go', context, new Set(), `// ${name} is the enum ${node.qn}.\ntype ${name} string\n\nconst (\n${values.join('\n')}\n)`);
}

function structStep(node: GraphNode, context: MapContext, file: string): Step {
    const imports = new Set<string>();
    const scope = goScope(node, context, imports);
    const fields = fieldsOf(node, context).filter(f => !f.data.derived).map(f => `\t${pascal(last(f.qn))} ${typeOf(f.data.type as TypeData, scope)} \`json:"${last(f.qn)}"\``);
    return goFile(node.module, file, context, imports, `// ${last(node.qn)} is the ${node.kind === 'Event' ? 'event' : 'value type'} ${node.qn}.\ntype ${last(node.qn)} struct {\n${fields.join('\n')}\n}`);
}

/** An entity becomes a struct with an ID, a constructor with the defaults, methods for derived fields, and Validate for the invariants. */
function entitySteps(entity: GraphNode, context: MapContext): Step[] {
    return [entityStep(entity, context), ...guardSteps(entity, context), ...storageSteps(entity, context, HELPERS)];
}

function entityStep(entity: GraphNode, context: MapContext): Step {
    const imports = new Set<string>();
    const name = last(entity.qn);
    const receiver = name.charAt(0).toLowerCase();
    const scope = goScope(entity, context, imports);
    const fields = fieldsOf(entity, context);
    const stored = fields.filter(f => !f.data.derived);
    const lines = [`// ${name} is the entity ${entity.qn}.`, `type ${name} struct {`, '\tID int64 `json:"id"`', ...stored.map(f => `\t${pascal(last(f.qn))} ${typeOf(f.data.type as TypeData, scope)} \`json:"${last(f.qn)}"\``), '}'];
    const defaults = stored.flatMap(f => {
        const code = defaultValue(f, scope);
        return code ? [`\t\t${pascal(last(f.qn))}: ${code},`] : [];
    });
    lines.push('', `// New${name} returns a new ${name} with the defaults of the model.`, `func New${name}() *${name} {`, `\treturn &${name}{`, ...defaults, '\t}', '}');
    for (const field of fields.filter(f => f.data.derived)) {
        const code = goExpr(field.data.derived as ExprData, { ...scope, self: receiver });
        if (code) lines.push('', `// ${pascal(last(field.qn))} is the derived field ${field.qn}.`, `func (${receiver} *${name}) ${pascal(last(field.qn))}() ${typeOf(field.data.type as TypeData, scope)} {`, `\treturn ${coerce(code, field)}`, '}');
    }
    const checks = context.children(entity.qn).filter(n => n.kind === 'Invariant').flatMap(invariant => {
        const condition = validation(invariant, context);
        return condition ? [`\tif !(${condition}) {`, `\t\terrs = append(errs, errors.New(${JSON.stringify(String(invariant.data.label))}))`, '\t}'] : [];
    });
    imports.add('errors');
    lines.push('', `// Validate checks the invariants of ${name}.`, `func (${receiver} *${name}) Validate() error {`, '\tvar errs []error', ...checks, '\treturn errors.Join(errs...)', '}');
    const path = tenantPaths(context).get(entity.qn);
    if (path) {
        const tenant = tenantOf(context)!;
        const hops = path.map((_, i) => [receiver, ...path.slice(0, i + 1).map(f => pascal(last(f.qn)))].join('.'));
        lines.push(
            '',
            `// TenantID returns the ID of the ${tenant.data.entity} this ${name} belongs to, for the tenant ${tenant.qn}.`,
            `func (${receiver} *${name}) TenantID() (int64, bool) {`,
            ...(hops.length ? [`\tif ${hops.map(h => `${h} == nil`).join(' || ')} {`, '\t\treturn 0, false', '\t}'] : []),
            `\treturn ${hops.at(-1) ?? receiver}.ID, true`,
            '}'
        );
    }
    return goFile(entity.module, 'types.go', context, imports, lines.join('\n'));
}

function fieldSteps(field: GraphNode, context: MapContext): Step[] | undefined {
    const owner = context.node(parentOf(field.qn))!;
    if (owner.kind === 'Event' || owner.kind === 'ValueType') return [];
    if (owner.kind === 'Actor') return actorFieldType(field, context, new Set()) ? [] : [task(`add the field ${last(field.qn)} of ${owner.qn} to the Actor of the access package; enums and value types have no form there yet`)];
    if (owner.kind !== 'Entity') return undefined;
    const scope = { ...goScope(owner, context, new Set()), self: 'x' };
    const tasks: Step[] = [];
    if (field.data.derived && !goExpr(field.data.derived as ExprData, scope)) tasks.push(task(`implement the derived field ${last(field.qn)} = ${field.props.derived}`));
    if (field.data.default && !defaultValue(field, scope)) tasks.push(task(`set the default of ${last(field.qn)} to ${field.props.default} in New${last(owner.qn)}`));
    return tasks;
}

function validation(invariant: GraphNode, context: MapContext): string | undefined {
    const entity = context.node(parentOf(invariant.qn))!;
    const name = last(entity.qn);
    return goExpr(invariant.data.condition as ExprData, { ...goScope(entity, context, new Set()), self: name.charAt(0).toLowerCase() });
}

/**
 * An action becomes a function on its entity: preconditions return the declared errors, the transition
 * checks the current state, effects change the record, and emitted events are returned.
 */
function actionSteps(action: GraphNode, context: MapContext): Step[] {
    const { step, tasks } = actionCode(action, context);
    return [step, ...guardSteps(action, context), ...tasks, ...(covered(context).has(action.qn) ? [] : testSteps(action, context))];
}

/** The generated function of an action, the tasks for what it leaves out, and what it takes besides the record and the inputs. */
function actionCode(action: GraphNode, context: MapContext): { step: Step, tasks: Step[], takesActor: boolean, creates: GraphNode[] } {
    const imports = new Set<string>();
    const entity = action.data.entity ? context.node(action.data.entity as string) : undefined;
    const self = entity ? camel(last(entity.qn)) : undefined;
    const scope = { ...goScope(action, context, imports), self };
    const tasks: Step[] = [];
    const body: string[] = ['var events []any'];
    const guard = guardOf(action, context);
    if (guard) {
        imports.add('fmt');
        body.push(`if !actor.IsSystem() && !${guard.name}(${['actor', ...guard.args].join(', ')}) {`, `\treturn nil, fmt.Errorf("%w: ${last(action.qn)}", ${accessIn(scope, 'ErrForbidden')})`, '}');
    }
    ((action.data.preconditions ?? []) as { condition: ExprData, error?: string }[]).forEach((precondition, i) => {
        const condition = goExpr(precondition.condition, scope);
        const text = (action.props.preconditions as string[])[i];
        if (!condition) {
            tasks.push(task(`check the precondition ${text} in ${last(action.qn)}`));
            return;
        }
        const error = precondition.error ? errorName(context.node(precondition.error)!) : `errors.New(${JSON.stringify(text)})`;
        if (!precondition.error) imports.add('errors');
        body.push(`if !(${condition}) {`, `\treturn nil, ${error}`, '}');
    });
    const transitions = context.graph.nodes.filter(n => n.kind === 'Transition' && n.data.action === action.qn);
    const creating = storing(action);
    if (transitions.length && self) body.push(...transitionSwitch(transitions, self, last(action.qn), scope, context, tasks, creating));
    body.push(...effectBlock(action, self, scope, context, tasks, creating));
    body.push('return events, nil');
    const takesActor = !!guard || enforced(context);
    const params = [
        ...(takesActor ? [`actor ${accessIn(scope, 'Actor')}`] : []),
        ...(entity ? [`${self} ${typeOf({ $type: 'TypeRef', decl: entity.qn } as TypeData, scope)}`] : []),
        ...context.children(action.qn).filter(c => c.kind === 'Param').map(p => `${camel(last(p.qn))} ${typeOf(p.data.type as TypeData, scope)}`),
        ...stores(creating).map(([name, e]) => `${name} func(${typeOf({ $type: 'TypeRef', decl: e.qn } as TypeData, scope)}) error`)
    ];
    const stored = stores(creating).length ? ` The records it creates, updates or deletes go to the store functions, which write them.` : '';
    const code = [`// ${last(action.qn)} is the action ${action.qn}. It returns the events it emits.${stored}`, `func ${last(action.qn)}(${params.join(', ')}) ([]any, error) {`, ...body.map(l => `\t${l}`), '}'].join('\n');
    return { step: goFile(action.module, 'actions.go', context, imports, code), tasks, takesActor, creates: stores(creating).map(([, e]) => e) };
}

/**
 * `In<Query>` in the module's `queries.go`: whether a record is among the query's results for its inputs, by the
 * filter. Loading, sorting and paging stay with the storage, the query's task; nothing when the filter does not translate.
 */
function queryFilterSteps(query: GraphNode, context: MapContext): Step[] {
    if (!query.data.filter) return [];
    const imports = new Set<string>();
    const entity = context.node(query.data.entity as string)!;
    const self = camel(last(entity.qn));
    const scope = { ...goScope(query, context, imports), self };
    const condition = goExpr(query.data.filter as ExprData, scope);
    if (!condition) return [];
    const params = [
        `${self} ${typeOf({ $type: 'TypeRef', decl: entity.qn } as TypeData, scope)}`,
        ...context.children(query.qn).filter(c => c.kind === 'Param').map(p => `${camel(last(p.qn))} ${typeOf(p.data.type as TypeData, scope)}`)
    ];
    const code = [
        `// In${last(query.qn)} reports whether a record is among the results of the query ${query.qn}${params.length > 1 ? ' for the inputs' : ''}.`,
        `func In${last(query.qn)}(${params.join(', ')}) bool {`,
        `\treturn ${condition}`,
        '}'
    ].join('\n');
    return [goFile(query.module, 'queries.go', context, imports, code)];
}

/** What the policy checks of an element receive besides the actor: the record they guard and the inputs. */
interface Guard {
    /** The guarded record's entity: the entity itself, or the entity of the action or query. */
    entity?: GraphNode;
    params: GraphNode[];
    /** The argument names after `actor`. */
    args: string[];
    /** The exported check, such as `CanPlaceOrder`. */
    name: string;
}

/**
 * The exported check of an element, when one applies. Once the model has any policy, every entity gets
 * `Can<Op><Entity>`, every action `Can<Action>` (its entity's update check and its own policies; an action
 * without an entity that only creates records leaves the check to the create check of the created entity),
 * and every query `Can<Query>` (its entity's read check and its own policies); what no policy covers is
 * denied. A use case gets `Can<UseCase>` for its own policies. Without policies, only the tenant guards actions.
 */
function guardOf(owner: GraphNode, context: MapContext): Guard | undefined {
    const own = policiesOf(owner, context);
    const entityQn = owner.kind === 'Entity' ? owner.qn : owner.data.entity as string | undefined;
    const entity = entityQn ? context.node(entityQn) : undefined;
    const applies = own.length > 0 || (enforced(context)
        ? owner.kind === 'Entity' || owner.kind === 'Query' || (owner.kind === 'Action' && (!!entity || !creates(owner, context)))
        : owner.kind === 'Action' && !!entity && tenantPaths(context).has(entity.qn));
    if (!applies) return undefined;
    const params = owner.kind === 'Action' || owner.kind === 'UseCase' || owner.kind === 'Query' ? context.children(owner.qn).filter(c => c.kind === 'Param') : [];
    return { entity, params, args: [...(entity ? [camel(last(entity.qn))] : []), ...params.map(p => camel(last(p.qn)))], name: `Can${last(owner.qn)}` };
}

/** Whether the model has any policy: then an operation that no policy covers is denied. */
function enforced(context: MapContext): boolean {
    return context.graph.nodes.some(n => n.kind === 'Policy');
}

/** Whether an action, or a transition it runs, creates a record. */
function creates(action: GraphNode, context: MapContext): boolean {
    const transitions = context.graph.nodes.filter(n => n.kind === 'Transition' && n.data.action === action.qn);
    return [action, ...transitions].some(n => context.children(n.qn).some(c => c.kind === 'CreateEffect'));
}

function policiesOf(owner: GraphNode, context: MapContext): GraphNode[] {
    return context.children(owner.qn).filter(c => c.kind === 'Policy');
}

function guardSignature(guard: Guard, scope: GoScope): string {
    return [
        `actor ${accessIn(scope, 'Actor')}`,
        ...(guard.entity ? [`${camel(last(guard.entity.qn))} ${typeOf({ $type: 'TypeRef', decl: guard.entity.qn } as TypeData, scope)}`] : []),
        ...guard.params.map(p => `${camel(last(p.qn))} ${typeOf(p.data.type as TypeData, scope)}`)
    ].join(', ');
}

/**
 * The exported checks of an element in its module's `policies.go`, combining its policies (and, for an action
 * or a query, the update or read check of its entity, or the tenant) with `&&`, false when there is nothing to
 * combine. An entity gets one per operation, false where no policy grants it, and one per operation and field
 * that a field policy narrows.
 */
function guardSteps(owner: GraphNode, context: MapContext): Step[] {
    const guard = guardOf(owner, context);
    if (!guard) return [];
    const imports = new Set<string>();
    const scope = goScope(owner, context, imports);
    const signature = guardSignature(guard, scope);
    const args = ['actor', ...guard.args].join(', ');
    const record = guard.entity && camel(last(guard.entity.qn));
    const tenant = guard.entity && tenantPaths(context).has(guard.entity.qn) ? `${accessIn(scope, 'InTenant')}(actor, ${record})` : undefined;
    const policies = policiesOf(owner, context);
    const call = (policy: GraphNode) => `${policyName(policy, context)}(${args})`;
    const blocks: string[] = [];
    if (owner.kind === 'Entity') {
        const name = last(owner.qn);
        for (const op of OPERATIONS) {
            const covering = policies.filter(p => covers(p, op) && !(p.data.fields as string[] | undefined)?.length);
            const parts = covering.length ? [...(tenant ? [tenant] : []), ...covering.map(call)] : ['false'];
            blocks.push([
                `// Can${pascal(op)}${name} reports whether the policies of ${owner.qn} let the actor ${op} the record${covering.length ? '' : `; no policy grants ${op}`}.`,
                `func Can${pascal(op)}${name}(${signature}) bool {`, `\treturn ${parts.join(' && ')}`, '}'
            ].join('\n'));
            const fields = [...new Set(policies.filter(p => covers(p, op)).flatMap(p => (p.data.fields ?? []) as string[]))];
            for (const field of fields) {
                const narrowing = policies.filter(p => covers(p, op) && ((p.data.fields ?? []) as string[]).includes(field));
                blocks.push([
                    `// Can${pascal(op)}${name}${pascal(last(field))} reports whether the actor may ${op} the field ${last(field)} of the record.`,
                    `func Can${pascal(op)}${name}${pascal(last(field))}(${signature}) bool {`, `\treturn ${[`Can${pascal(op)}${name}(${args})`, ...narrowing.map(call)].join(' && ')}`, '}'
                ].join('\n'));
            }
        }
    } else {
        const op = owner.kind === 'Query' ? 'Read' : 'Update';
        const entity = guard.entity;
        const inherited = entity && owner.kind !== 'UseCase' && enforced(context)
            ? [`${entity.module === owner.module ? '' : `${qualifyModule(entity.module, scope)}.`}Can${op}${last(entity.qn)}(actor, ${record})`]
            : tenant ? [tenant] : [];
        const what = owner.kind === 'Query' ? `read a record through ${owner.qn}` : `run ${owner.qn}`;
        const parts = [...inherited, ...policies.map(call)];
        blocks.push([
            `// ${guard.name} reports whether the actor may ${what}${inherited.length ? `, including the ${inherited[0] === tenant ? 'tenant' : op.toLowerCase()} check of ${entity!.qn}` : ''}${parts.length ? '' : '; no policy grants it'}.`,
            `func ${guard.name}(${signature}) bool {`, `\treturn ${parts.length ? parts.join(' && ') : 'false'}`, '}'
        ].join('\n'));
    }
    return [goFile(owner.module, 'policies.go', context, imports, blocks.join('\n\n')), accessFile(context, accessOf(context))];
}

/** One function per policy, `<owner>Policy<Operations>`, with the arguments of its element's check; false with a task when Go cannot say the condition. */
function policySteps(policy: GraphNode, context: MapContext): Step[] {
    const guard = guardOf(context.node(parentOf(policy.qn))!, context)!;
    const imports = new Set<string>();
    const scope: GoScope = { ...goScope(policy, context, imports), self: guard.entity && camel(last(guard.entity.qn)), actor: 'actor' };
    const condition = goExpr(policy.data.condition as ExprData, scope);
    const name = policyName(policy, context);
    const code = [
        `// ${name} is the policy ${policy.qn}: ${policy.props.condition}`,
        `func ${name}(${guardSignature(guard, scope)}) bool {`,
        `\treturn ${condition ?? 'false'}`,
        '}'
    ].join('\n');
    return [goFile(policy.module, 'policies.go', context, imports, code), ...(condition ? [] : [task(`implement the policy ${policy.qn} in ${name}: ${policy.props.condition}`)])];
}

function policyName(policy: GraphNode, context: MapContext): string {
    const owner = parentOf(policy.qn);
    const words = /\[(.*)\]$/.exec(policy.qn)![1].split(/[^A-Za-z0-9]+/).filter(Boolean).map(pascal).join('');
    const same = policiesOf(context.node(owner)!, context).filter(p => p.qn === policy.qn);
    return `${camel(last(owner))}Policy${words}${same.length > 1 ? same.indexOf(policy) + 1 : ''}`;
}

function covers(policy: GraphNode, op: string): boolean {
    const operations = policy.data.operations as string[] | undefined;
    return !operations?.length || operations.includes(op);
}

/** A name from the access package, imported. */
function accessIn(scope: GoScope, name: string): string {
    scope.imports.add(scope.access!.path);
    return `${scope.access!.pkg}.${name}`;
}

function qualifyModule(module: string, scope: GoScope): string {
    scope.imports.add(scope.importOf(module));
    return module.split('.').pop()!;
}

function transitionSwitch(transitions: GraphNode[], self: string, label: string, scope: GoScope, context: MapContext, tasks: Step[], creating?: Creating): string[] {
    const machine = context.node(parentOf(transitions[0].qn))!;
    const field = context.node(machine.data.field as string)!;
    const enumNode = context.node((field.data.type as TypeData).decl!)!;
    const state = `${self}.${pascal(last(field.qn))}`;
    const lines = ['switch {'];
    for (const transition of transitions) {
        const from = (transition.data.from as string[]).map(s => `${state} == ${enumConstant(context.node(`${enumNode.qn}.${s}`)!, scope)}`).join(' || ');
        let condition = from;
        if (transition.data.guard) {
            const guard = goExpr(transition.data.guard as ExprData, scope);
            if (guard) condition = `(${from}) && (${guard})`;
            else tasks.push(task(`check the guard ${transition.props.guard} of ${last(transition.qn)}`));
        }
        lines.push(`case ${condition}:`);
        lines.push(...effectBlock(transition, self, scope, context, tasks, creating).map(l => `\t${l}`));
        lines.push(`\t${state} = ${enumConstant(context.node(`${enumNode.qn}.${transition.data.to}`)!, scope)}`);
    }
    scope.imports.add('fmt');
    scope.imports.add(scope.importOf(machine.module));
    const invalid = machine.module.split('.').pop() === scope.pkg ? 'ErrInvalidTransition' : `${machine.module.split('.').pop()}.ErrInvalidTransition`;
    lines.push('default:', `\treturn nil, fmt.Errorf("%w: ${label} from %s", ${invalid}, ${state})`, '}');
    return lines;
}

/**
 * The records an action writes besides its own: each created, updated or deleted entity becomes a `create<Entity>`,
 * `update<Entity>` or `delete<Entity>` function parameter that stores the change.
 */
interface Creating {
    action: string;
    entities: Map<string, GraphNode>;
    updates: Map<string, GraphNode>;
    deletes: Map<string, GraphNode>;
}

function storing(action: GraphNode): Creating {
    return { action: last(action.qn), entities: new Map(), updates: new Map(), deletes: new Map() };
}

/** The store functions an action takes, in order: creates, updates, deletes. */
function stores(creating: Creating): [string, GraphNode][] {
    return ([['create', creating.entities], ['update', creating.updates], ['delete', creating.deletes]] as const)
        .flatMap(([verb, map]) => [...map.values()].map(e => [`${verb}${last(e.qn)}`, e] as [string, GraphNode]));
}

/** The effects below an action, a transition or a loop in order; an `as` name is a variable for the effects after it. */
function effectBlock(owner: GraphNode, self: string | undefined, scope: GoScope, context: MapContext, tasks: Step[], creating?: Creating): string[] {
    const lines: string[] = [];
    let current = scope;
    for (const effect of context.children(owner.qn).filter(c => c.kind.endsWith('Effect'))) {
        lines.push(...effectLines(effect, self, current, context, tasks, creating));
        const variable = effect.data.variable as string | undefined;
        if (effect.kind === 'CreateEffect' && variable) current = { ...current, vars: new Map([...(current.vars ?? []), [variable, 'other']]) };
    }
    return lines;
}

function effectLines(effect: GraphNode, self: string | undefined, scope: GoScope, context: MapContext, tasks: Step[], creating?: Creating): string[] {
    if (effect.kind === 'ForEffect') {
        const variable = effect.data.variable as string;
        if (!self) {
            tasks.push(task(`apply the effect ${last(effect.qn)}`));
            return [];
        }
        const body = effectBlock(effect, self, { ...scope, vars: new Map([...(scope.vars ?? []), [variable, 'other']]) }, context, tasks, creating);
        const used = body.some(l => new RegExp(`\\b${variable}\\b`).test(l));
        return [`for ${used ? `_, ${variable} := ` : ''}range ${self}.${pascal(last(effect.data.collection as string))} {`, ...body.map(l => `\t${l}`), '}'];
    }
    if (effect.kind === 'UpdateEffect' || effect.kind === 'DeleteEffect') return recordLines(effect, self, scope, context, tasks, creating);
    if (effect.kind === 'SetEffect') {
        const field = context.node(effect.data.field as string)!;
        const value = self && assigned(field, effect.data.value as ExprData, scope);
        if (!value) {
            tasks.push(task(`apply the effect set ${last(field.qn)} = ${effect.props.value}`));
            return [];
        }
        return [`${self}.${pascal(last(field.qn))} = ${value}`];
    }
    if (effect.kind === 'EmitEffect') {
        const event = context.node(effect.data.event as string)!;
        const given = new Map(((effect.data.assignments ?? []) as { name: string, value: ExprData }[]).map(a => [a.name, a.value]));
        const values: string[] = [];
        const missing: string[] = [];
        for (const field of fieldsOf(event, context).filter(f => !f.data.derived)) {
            const type = field.data.type as TypeData;
            const expr = given.get(last(field.qn));
            const value = expr && assigned(field, expr, scope);
            if (value) values.push(`${pascal(last(field.qn))}: ${value}`);
            else if (expr || (!type.optional && !type.many)) missing.push(last(field.qn));
        }
        if (missing.length) {
            tasks.push(task(`emit ${last(event.qn)} with its fields ${missing.join(', ')}, which the model does not give or Go cannot say`));
            return [];
        }
        return [`events = append(events, ${qualify(event, scope)}{${values.join(', ')}})`];
    }
    if (effect.kind === 'CreateEffect') {
        const entity = context.node(effect.data.entity as string)!;
        const lines = creating && createLines(effect, entity, scope, context, creating);
        if (lines) return lines;
        const check = enforced(context) && runByActor(effect, context) ? `, after checking ${entity.module === scope.pkg ? '' : `${pkgOf(entity.module)}.`}CanCreate${last(entity.qn)}(actor, record)` : '';
        tasks.push(task(`create the ${last(entity.qn)} through your storage layer${check}`));
        return [];
    }
    tasks.push(task(`apply the effect ${last(effect.qn)}, for example through your storage layer`));
    return [];
}

/**
 * `update <path>` sets the fields of the related record and hands it to `update<Entity>`, `delete <path>` and
 * `delete self` hand the record to `delete<Entity>`; once the model has policies, the actor needs the entity's
 * update or delete check first. An optional path changes nothing when it is nil. Outside actions, a task.
 */
function recordLines(effect: GraphNode, self: string | undefined, scope: GoScope, context: MapContext, tasks: Step[], creating?: Creating): string[] {
    const entity = context.node(effect.data.entity as string);
    const operation = effect.kind === 'UpdateEffect' ? 'update' : 'delete';
    const target = effect.data.target as ExprData | undefined;
    const path = effect.data.self ? self : target && goTerm(target, scope)?.raw;
    const sets: string[] = [];
    for (const set of operation === 'update' ? context.children(effect.qn).filter(c => c.kind === 'SetEffect') : []) {
        const field = context.node(set.data.field as string)!;
        const value = entity && assigned(field, throughPath(set.data.value as ExprData, entity.qn, target!), scope);
        if (!value) break;
        sets.push(`${path}.${pascal(last(field.qn))} = ${value}`);
    }
    const complete = operation === 'delete' || sets.length === context.children(effect.qn).filter(c => c.kind === 'SetEffect').length;
    if (!creating || !entity || !path || !complete) {
        tasks.push(task(`apply the effect ${last(effect.qn)}: ${operation} ${effect.data.self ? 'self' : effect.props.target}, for example through your storage layer`));
        return [];
    }
    (operation === 'update' ? creating.updates : creating.deletes).set(entity.qn, entity);
    const check = enforced(context) ? [
        `if !actor.IsSystem() && !${entity.module === effect.module ? '' : `${qualifyModule(entity.module, scope)}.`}Can${pascal(operation)}${last(entity.qn)}(actor, ${path}) {`,
        `\treturn nil, fmt.Errorf("%w: ${creating.action}", ${accessIn(scope, 'ErrForbidden')})`,
        '}'
    ] : [];
    if (check.length) scope.imports.add('fmt');
    const write = [...check, ...sets, `if err := ${operation}${last(entity.qn)}(${path}); err != nil {`, '\treturn nil, err', '}'];
    return target?.type.endsWith('?') ? [`if ${path} != nil {`, ...write.map(l => `\t${l}`), '}'] : write;
}

/**
 * A create effect in an action: a block that builds the record with `New<Entity>` and the given fields, checks
 * `CanCreate<Entity>` once the model has policies, and hands the record to `create<Entity>`. Undefined when a
 * required field without default is not given or a value does not translate.
 */
function createLines(effect: GraphNode, entity: GraphNode, scope: GoScope, context: MapContext, creating: Creating): string[] | undefined {
    const given = new Map(((effect.data.assignments ?? []) as { name: string, value: ExprData }[]).map(a => [a.name, a.value]));
    // A named row stays a variable for the effects after it; an unnamed one lives in its own block.
    const variable = effect.data.variable as string | undefined;
    const record = variable ?? 'created';
    const lines: string[] = [];
    for (const field of fieldsOf(entity, context).filter(f => !f.data.derived)) {
        const type = field.data.type as TypeData;
        const expr = given.get(last(field.qn));
        if (!expr) {
            if (!type.optional && !type.many && !field.data.default) return undefined;
            continue;
        }
        const value = assigned(field, expr, scope);
        if (!value) return undefined;
        lines.push(`${record}.${pascal(last(field.qn))} = ${value}`);
    }
    const name = qualify(entity, scope);
    const constructor = name.includes('.') ? name.replace(/\.(\w+)$/, '.New$1') : `New${name}`;
    const check = enforced(context) ? [
        `if !actor.IsSystem() && !${entity.module === effect.module ? '' : `${qualifyModule(entity.module, scope)}.`}CanCreate${last(entity.qn)}(actor, ${record}) {`,
        `\treturn nil, fmt.Errorf("%w: ${creating.action}", ${accessIn(scope, 'ErrForbidden')})`,
        '}'
    ] : [];
    if (check.length) scope.imports.add('fmt');
    creating.entities.set(entity.qn, entity);
    const code = [`${record} := ${constructor}()`, ...lines, ...check, `if err := create${last(entity.qn)}(${record}); err != nil {`, '\treturn nil, err', '}'];
    return variable ? code : ['{', ...code.map(l => `\t${l}`), '}'];
}

/** Whether an effect runs in an action, which takes the actor, rather than in a transition on an event. */
function runByActor(effect: GraphNode, context: MapContext): boolean {
    let owner = context.node(effect.qn.slice(0, effect.qn.lastIndexOf('.effect[')));
    while (owner?.kind.endsWith('Effect')) owner = context.node(owner.qn.slice(0, owner.qn.lastIndexOf('.effect[')));
    return owner?.kind === 'Action' || (owner?.kind === 'Transition' && !!owner.data.action);
}

/**
 * An expression as the value of a field: records are pointers already, an optional field takes a pointer as it
 * is and a value through `ptr`, and number literals become decimals for decimal fields.
 */
function assigned(field: GraphNode, expr: ExprData, scope: GoScope): string | undefined {
    const term = goTerm(expr, scope);
    if (!term) return undefined;
    const type = field.data.type as TypeData;
    const entity = !!type.decl && scope.node(type.decl)?.kind === 'Entity';
    if (term.null) return type.optional || type.many || entity ? 'nil' : undefined;
    if (term.empty && type.many) return `${typeOf(type, scope)}{}`;
    if (entity || type.many) return term.raw;
    // An untyped constant would make `ptr` return *int.
    if (type.optional) return term.pointer ? term.raw : `ptr${type.primitive === 'Int' ? '[int64]' : ''}(${coerce(term.value, field)})`;
    return coerce(term.value, field);
}

/** Transitions on an event become a function that applies them to the record the event carries. */
function machineSteps(machine: GraphNode, context: MapContext): Step[] {
    const field = context.node(machine.data.field as string)!;
    const entity = context.node(parentOf(field.qn))!;
    const imports = new Set(['errors']);
    const steps: Step[] = [goFile(machine.module, 'errors.go', context, imports, `// ErrInvalidTransition is returned when the state does not allow an action.\nvar ErrInvalidTransition = errors.New("invalid transition")`)];
    const byEvent = Map.groupBy(context.children(machine.qn).filter(t => t.kind === 'Transition' && t.data.event), t => t.data.event as string);
    for (const [eventQn, transitions] of byEvent) {
        const event = context.node(eventQn)!;
        const carrier = fieldsOf(event, context).find(f => (f.data.type as TypeData).decl === entity.qn);
        if (!carrier) {
            steps.push(task(`apply the transitions of ${last(machine.qn)} on ${last(eventQn)}; the event carries no ${last(entity.qn)}`));
            continue;
        }
        const handlerImports = new Set<string>();
        const scope = { ...goScope(machine, context, handlerImports), self: `event.${pascal(last(carrier.qn))}` };
        const tasks: Step[] = [];
        const body = ['var events []any', ...transitionSwitch(transitions, scope.self, last(eventQn), scope, context, tasks), 'return events, nil'];
        const name = `${last(machine.qn)}On${last(eventQn)}`;
        steps.push(goFile(machine.module, 'machines.go', context, handlerImports, `// ${name} applies the transitions of ${machine.qn} that ${last(eventQn)} triggers.\nfunc ${name}(event ${qualify(event, scope)}) ([]any, error) {\n${body.map(l => `\t${l}`).join('\n')}\n}`), ...tasks);
    }
    return steps;
}

/** A skipped test per case of a rule in the module's test file; writing its body is a registry task. */
function testSteps(node: GraphNode, context: MapContext): Step[] {
    const name = testName(node);
    const code = `func ${name}(t *testing.T) {\n\tt.Skip(${JSON.stringify(`registry task: ${node.qn}`)})\n}`;
    return [goFile(node.module, `${pkgOf(node.module)}_test.go`, context, new Set(['testing']), code), task(`write the test ${name}`)];
}

const POLICY_CASES = ['allows permitted actors', 'denies other actors'];

/**
 * The test of a policy on a whole entity whose condition reads the actor only through `actor.is(...)`: the
 * entity's valid record and `access.New<Actor>()` of a declared actor go to `Can<Op><Entity>`. `allows permitted
 * actors` takes the first actor the simulator proves this policy lets through and asserts every operation whose
 * whole record policies all read the actor that way and grant it; `denies other actors` takes the first actor the
 * simulator proves this policy keeps out and refutes every operation it covers (the checks combine with `&&`).
 * A case without such an actor stays skipped as a task; field policies, policies on other elements and a condition
 * that reads more of the actor or that Go cannot say keep the whole test skipped.
 */
function policyTestSteps(policy: GraphNode, context: MapContext): Step[] {
    const entity = context.node(parentOf(policy.qn));
    if (entity?.kind !== 'Entity' || ((policy.data.fields ?? []) as string[]).length) return testSteps(policy, context);
    const wholes = policiesOf(entity, context).filter(p => !((p.data.fields ?? []) as string[]).length);
    const record = camel(last(entity.qn));
    const dry: GoScope = { ...goScope(entity, context, new Set()), self: record, actor: 'actor' };
    const checkable = (p: GraphNode) => onlyActorKinds(p.data.condition as ExprData, context) && !!goExpr(p.data.condition as ExprData, dry);
    if (!checkable(policy)) return testSteps(policy, context);
    const valid = validRecord(entity, context);
    if (!valid) return testSteps(policy, context);
    const imports = new Set(['testing']);
    const scope = goScope(policy, context, imports);
    const sim = simulator(context);
    const verdict = (p: GraphNode, actor: GraphNode) => sim.evaluate(p.data.condition as ExprData, { self: valid.record, actor: { actor: actor.qn, fields: {} } });
    const operations = OPERATIONS.filter(op => covers(policy, op));
    const actors = context.graph.nodes.filter(n => n.kind === 'Actor');
    const allowed = actors.map(actor => ({ actor, operations: operations.filter(op => wholes.filter(p => covers(p, op)).every(p => checkable(p) && verdict(p, actor) === true)) }))
        .find(a => verdict(policy, a.actor) === true && a.operations.length);
    const deniedActor = actors.find(actor => verdict(policy, actor) === false);
    const denied = deniedActor && { actor: deniedActor, operations };
    if (!allowed && !denied) return testSteps(policy, context);
    const name = testName(policy);
    const entityName = last(entity.qn);
    const body = (label: string, found: { actor: GraphNode, operations: string[] } | undefined, want: boolean) => [
        `\tt.Run(${JSON.stringify(label)}, func(t *testing.T) {`,
        ...(found ? [
            `\t\tactor := ${accessIn(scope, `New${accessOf(context).name(found.actor.qn)}`)}()`,
            `\t\t${record} := ${valid.name}()`,
            ...found.operations.flatMap(op => {
                const check = `Can${pascal(op)}${entityName}`;
                return [
                    `\t\tif ${want ? '!' : ''}${check}(actor, ${record}) {`,
                    `\t\t\tt.Error(${JSON.stringify(`${check}: want ${want} for ${found.actor.qn}`)})`,
                    '\t\t}'
                ];
            })
        ] : [`\t\tt.Skip(${JSON.stringify(`registry task: ${policy.qn}`)})`]),
        '\t})'
    ];
    const code = [`func ${name}(t *testing.T) {`, ...body(POLICY_CASES[0], allowed, true), ...body(POLICY_CASES[1], denied, false), '}'].join('\n');
    const missing = [allowed ? undefined : POLICY_CASES[0], denied ? undefined : POLICY_CASES[1]].filter(c => c !== undefined);
    return [
        valid.step,
        goFile(policy.module, `${pkgOf(policy.module)}_test.go`, context, imports, code),
        ...missing.map(c => task(`write the ${c} case of the test ${name}`))
    ];
}

/**
 * Whether the condition reads the actor only through `actor.is(X)` with an X whose verdict needs no actor field
 * (an actor, or a role without a condition), and not the tenant, so `access.New<Actor>()` has the simulated verdict.
 */
function onlyActorKinds(expr: ExprData | undefined, context: MapContext): boolean {
    if (!expr) return true;
    if (expr.$type === 'MemberExpr' && expr.member === 'is' && expr.call && expr.receiver?.$type === 'NameExpr' && expr.receiver.name === 'actor' && !expr.receiver.target) {
        const target = expr.args?.[0]?.target;
        const node = target ? context.node(target) : undefined;
        return node?.kind === 'Actor' || node?.kind === 'Role' && !node.data.condition;
    }
    if (expr.$type === 'NameExpr' && (expr.name === 'actor' || expr.name === 'tenant') && !expr.target) return false;
    const parts = [expr.left, expr.right, expr.operand, expr.receiver, expr.index, ...(expr.args ?? []), ...(expr.items ?? [])];
    return parts.every(p => onlyActorKinds(p, context));
}

function testName(node: GraphNode): string {
    return `Test${pascal(last(parentOf(node.qn)))}${pascal(String(node.data.label ?? last(node.qn)).replace(/[^A-Za-z0-9]+/g, '_'))}`.replace(/_/g, '');
}

const simulators = new WeakMap<Graph, Simulator>();

/** One simulator per graph, which proves that a test record satisfies or breaks an invariant. */
function simulator(context: MapContext): Simulator {
    let found = simulators.get(context.graph);
    if (!found) simulators.set(context.graph, found = new Simulator(context.graph));
    return found;
}

/**
 * The test of an invariant that `Validate` checks: the entity's valid record passes `Validate`, and the same
 * record with one field the simulator proves to break the invariant fails with its label. Without a valid
 * record the test stays skipped; without such a field value only the violation case does, as a registry task.
 */
function invariantTestSteps(invariant: GraphNode, context: MapContext): Step[] {
    const entity = context.node(parentOf(invariant.qn))!;
    if (!validation(invariant, context)) return testSteps(invariant, context);
    const imports = new Set(['testing']);
    const scope = goScope(entity, context, imports);
    const valid = validRecord(entity, context);
    if (!valid) return testSteps(invariant, context);
    const label = JSON.stringify(String(invariant.data.label));
    const violation = violating(invariant, entity, valid.record, context, scope);
    if (violation) imports.add('strings');
    const name = testName(invariant);
    const code = [
        `func ${name}(t *testing.T) {`,
        '\tt.Run("holds for a valid record", func(t *testing.T) {',
        `\t\tif err := ${valid.name}().Validate(); err != nil {`,
        `\t\t\tt.Fatalf("a valid ${last(entity.qn)}: %v", err)`,
        '\t\t}',
        '\t})',
        '\tt.Run("rejects a violation", func(t *testing.T) {',
        ...(violation ? [
            `\t\tx := ${valid.name}()`,
            `\t\t${violation}`,
            `\t\tif err := x.Validate(); err == nil || !strings.Contains(err.Error(), ${label}) {`,
            `\t\t\tt.Fatalf(${JSON.stringify(`${violation}: want the error %q, got %v`)}, ${label}, err)`,
            '\t\t}'
        ] : [`\t\tt.Skip(${JSON.stringify(`registry task: ${invariant.qn}`)})`]),
        '\t})',
        '}'
    ].join('\n');
    return [
        valid.step,
        goFile(invariant.module, `${pkgOf(invariant.module)}_test.go`, context, imports, code),
        ...(violation ? [] : [task(`write the violation case of the test ${name}`)])
    ];
}

/**
 * The test of a transition an action runs: the entity's valid record in a `from` state goes to the `to`
 * state through the action, and, when the action allows a state no transition leaves, the action refuses it
 * with `ErrInvalidTransition`. The simulator must prove that the preconditions and the guard hold and that no
 * earlier case of the switch takes the record; without that (an actor to pass, an input or state it cannot
 * say, code in another package) the test stays skipped as a registry task.
 */
function transitionTestSteps(transition: GraphNode, context: MapContext): Step[] {
    const plan = transitionTest(transition, context);
    if (!plan) return testSteps(transition, context);
    const { action, valid, state, from, to, invalid, args, actor, imports } = plan;
    const call = `${last(action.qn)}(${[...(actor ? [actor] : []), 'x', ...args].join(', ')})`;
    const name = testName(transition);
    const code = [
        `func ${name}(t *testing.T) {`,
        `\tt.Run("goes from ${from.label} to ${to.label}", func(t *testing.T) {`,
        `\t\tx := ${valid.name}()`,
        `\t\tx.${state} = ${from.go}`,
        `\t\tif _, err := ${call}; err != nil {`,
        `\t\t\tt.Fatalf("${last(action.qn)} from ${from.label}: %v", err)`,
        '\t\t}',
        `\t\tif x.${state} != ${to.go} {`,
        `\t\t\tt.Fatalf("${last(action.qn)} from ${from.label}: want ${to.label}, got %v", x.${state})`,
        '\t\t}',
        '\t})',
        ...(invalid ? [
            `\tt.Run("refuses ${invalid.label}", func(t *testing.T) {`,
            `\t\tx := ${valid.name}()`,
            `\t\tx.${state} = ${invalid.go}`,
            `\t\tif _, err := ${call}; !errors.Is(err, ErrInvalidTransition) {`,
            `\t\t\tt.Fatalf("${last(action.qn)} from ${invalid.label}: want ErrInvalidTransition, got %v", err)`,
            '\t\t}',
            '\t})'
        ] : []),
        '}'
    ].join('\n');
    if (invalid) imports.add('errors');
    return [valid.step, goFile(transition.module, `${pkgOf(transition.module)}_test.go`, context, imports, code)];
}

interface Literal { go: string, label: string }

function transitionTest(transition: GraphNode, context: MapContext) {
    const action = transition.data.action ? context.node(transition.data.action as string) : undefined;
    const machine = context.node(parentOf(transition.qn))!;
    const entity = action?.data.entity ? context.node(action.data.entity as string) : undefined;
    if (!action || !entity || !(machine.data.field as string).startsWith(`${entity.qn}.`)) return undefined;
    // Code in another package is more than a generated test sets up.
    if (action.module !== transition.module || entity.module !== transition.module) return undefined;
    const imports = new Set(['testing']);
    const scope = goScope(transition, context, imports);
    const valid = validRecord(entity, context);
    if (!valid) return undefined;
    const transitions = context.graph.nodes.filter(n => n.kind === 'Transition' && n.data.action === action.qn);
    const self = camel(last(entity.qn));
    const dry = { ...goScope(action, context, new Set()), self };
    const args: string[] = [];
    const inputs: { [name: string]: Value } = {};
    const takesActor = !!guardOf(action, context) || enforced(context);
    // The store functions the action takes, found the way actionSteps finds them; the test stores nothing.
    const creating = storing(action);
    transitionSwitch(transitions, self, last(action.qn), dry, context, [], creating);
    effectBlock(action, self, dry, context, [], creating);
    if (takesActor) {
        // Every policy the simulator weighs must be one Go checks, or Go denies where the simulator allows.
        const written = stores(creating).map(([, e]) => e.qn);
        const policies = [action.qn, entity.qn, ...written].flatMap(qn => context.children(qn)).filter(c => c.kind === 'Policy');
        if (!policies.every(p => goExpr(p.data.condition as ExprData, { ...dry, actor: 'actor' }))) return undefined;
    }
    for (const param of context.children(action.qn).filter(c => c.kind === 'Param')) {
        const type = param.data.type as TypeData;
        if (type.optional || type.many) {
            args.push('nil');
            inputs[last(param.qn)] = type.many ? [] : null;
            continue;
        }
        const sample = goSample(last(param.qn), type, scope, context);
        if (!sample || sample.value === UNKNOWN) return undefined;
        args.push(sample.go);
        inputs[last(param.qn)] = sample.value;
    }
    for (const [, stored] of stores(creating)) args.push(`func(${typeOf({ $type: 'TypeRef', decl: stored.qn } as TypeData, scope)}) error { return nil }`);
    const field = context.node(machine.data.field as string)!;
    const enumNode = context.node((field.data.type as TypeData).decl!)!;
    const literal = (value: string): Literal => ({ go: enumConstant(context.node(`${enumNode.qn}.${value}`)!, scope), label: value });
    const sim = simulator(context);
    const holds = (record: SimRecord) => ((action.data.preconditions ?? []) as { condition: ExprData }[]).every(p => sim.evaluate(p.condition, { self: record, inputs }) === true);
    const guard = (t: GraphNode, record: SimRecord) => t.data.guard ? sim.evaluate(t.data.guard as ExprData, { self: record, inputs }) : true;
    const fieldName = last(field.qn);
    const from = (transition.data.from as string[]).find(state => {
        const record = { ...valid.record, [fieldName]: state };
        if (!holds(record)) return false;
        for (const t of transitions) {
            if (!(t.data.from as string[]).includes(state)) continue;
            const verdict = guard(t, record);
            if (t === transition) return verdict === true && (!t.data.guard || !!goExpr(t.data.guard as ExprData, dry));
            // An earlier case takes the record unless Go checks its guard and the guard is false.
            if (verdict !== false || !goExpr(t.data.guard as ExprData, dry)) return false;
        }
        return false;
    });
    if (!from) return undefined;
    let actor: string | undefined;
    if (takesActor) {
        // The first declared actor the simulator proves the policies let run the action, created as New<Actor> makes it.
        const record = { ...valid.record, [fieldName]: from };
        const found = context.graph.nodes.filter(n => n.kind === 'Actor').find(a => sim.run(action.qn, record, { actor: a.qn }, inputs).allowed === 'yes');
        if (!found) return undefined;
        actor = `${accessIn(scope, `New${accessOf(context).name(found.qn)}`)}()`;
    }
    const left = new Set(transitions.flatMap(t => t.data.from as string[]));
    const invalid = context.children(enumNode.qn).map(c => last(c.qn)).find(state => !left.has(state) && holds({ ...valid.record, [fieldName]: state }));
    return {
        action, valid, imports, args, actor,
        state: pascal(fieldName),
        from: literal(from),
        to: literal(transition.data.to as string),
        invalid: invalid ? literal(invalid) : undefined
    };
}

/**
 * The test helper `valid<Entity>` in the module's test file: `New<Entity>` with a sample value for every
 * required stored field without a default that has one (strings, numbers, booleans, times, the first enum
 * literal), and the record the simulator sees. Undefined when an invariant `Validate` checks is not proven to hold.
 */
function validRecord(entity: GraphNode, context: MapContext): { name: string, record: SimRecord, step: Step } | undefined {
    const name = `valid${last(entity.qn)}`;
    const imports = new Set<string>();
    const scope = goScope(entity, context, imports);
    const record: SimRecord = { $type: entity.qn };
    const lines: string[] = [];
    for (const field of fieldsOf(entity, context).filter(f => !f.data.derived)) {
        const type = field.data.type as TypeData;
        const fieldName = last(field.qn);
        if (type.many) record[fieldName] = [];
        // The default only decides whether the simulator sees its value; `New<Entity>` writes it, so its imports stay out.
        else if (field.data.default) record[fieldName] = defaultValue(field, { ...scope, imports: new Set(), self: 'x' }) ?simulator(context).evaluate(field.data.default as ExprData, { self: record }) : UNKNOWN;
        else if (type.optional) record[fieldName] = null;
        else {
            const sample = goSample(fieldName, type, scope, context);
            record[fieldName] = sample?.value ?? UNKNOWN;
            if (sample) lines.push(`\tx.${pascal(fieldName)} = ${sample.go}`);
        }
    }
    const checked = context.children(entity.qn).filter(n => n.kind === 'Invariant' && validation(n, context));
    if (!checked.every(i => simulator(context).evaluate(i.data.condition as ExprData, { self: record }) === true)) return undefined;
    const code = [
        `// ${name} returns ${/^[AEIOU]/.test(last(entity.qn)) ? 'an' : 'a'} ${last(entity.qn)} with the defaults of the model and a sample value for every other required field.`,
        `func ${name}() *${last(entity.qn)} {`, `\tx := New${last(entity.qn)}()`, ...lines, '\treturn x', '}'
    ].join('\n');
    const file = goFile(entity.module, `${pkgOf(entity.module)}_test.go`, context, imports, code) as Extract<Step, { kind: 'template' }>;
    const step: Step = { ...file, write: existing => existing?.includes(`\nfunc ${name}() `) ? existing : file.write(existing) };
    return { name, record, step };
}

/** A sample value of a required field in Go and as the simulator sees it; undefined for files, value types and records. */
function goSample(name: string, type: TypeData, scope: GoScope, context: MapContext): { go: string, value: Value } | undefined {
    if (type.decl) {
        const decl = context.node(type.decl);
        const first = decl?.kind === 'Enum' ? context.children(decl.qn)[0] : undefined;
        return first ? { go: enumConstant(first, scope), value: last(first.qn) } : undefined;
    }
    switch (type.primitive) {
        case 'String':
        case 'Text': return { go: JSON.stringify(`${name}-1`), value: `${name}-1` };
        case 'Uuid': return { go: '"00000000-0000-4000-8000-000000000001"', value: '00000000-0000-4000-8000-000000000001' };
        case 'Int': return { go: '1', value: 1 };
        case 'Decimal':
        case 'Money':
            scope.imports.add(DECIMAL);
            return { go: 'decimal.NewFromInt(1)', value: 1 };
        case 'Bool': return { go: 'false', value: false };
        case 'Date':
        case 'DateTime':
            scope.imports.add('time');
            return { go: 'time.Now()', value: UNKNOWN };
        case 'Duration':
            scope.imports.add('time');
            return { go: 'time.Hour', value: 3_600_000 };
    }
    return undefined;
}

interface Candidate {
    go: string;
    value: Value;
    imports: string[];
    /** The conversion an untyped constant needs inside `ptr`, such as `int64`. */
    cast?: string;
}

/**
 * An assignment such as `x.Total = decimal.NewFromInt(-1)` that makes the invariant false on the valid record,
 * trying the fields the condition reads in order.
 */
function violating(invariant: GraphNode, entity: GraphNode, record: SimRecord, context: MapContext, scope: GoScope): string | undefined {
    const condition = invariant.data.condition as ExprData;
    const read = targets(condition);
    for (const field of fieldsOf(entity, context).filter(f => read.has(f.qn) && !f.data.derived && !(f.data.type as TypeData).many)) {
        for (const candidate of candidates(field.data.type as TypeData, scope, context)) {
            if (simulator(context).evaluate(condition, { self: { ...record, [last(field.qn)]: candidate.value } }) !== false) continue;
            candidate.imports.forEach(i => scope.imports.add(i));
            return `x.${pascal(last(field.qn))} = ${candidate.go}`;
        }
    }
    return undefined;
}

/** The values tried on a field: a few numbers, both booleans, the empty string, every enum literal, and nil when optional. */
function candidates(type: TypeData, scope: GoScope, context: MapContext): Candidate[] {
    const found: Candidate[] = [];
    if (type.decl) {
        const decl = context.node(type.decl);
        if (decl?.kind === 'Enum') for (const literal of context.children(decl.qn)) found.push({ go: enumConstant(literal, scope), value: last(literal.qn), imports: [] });
    } else {
        const numbers = [-1, 0, 1_000_000];
        switch (type.primitive) {
            case 'Int': found.push(...numbers.map(n => ({ go: String(n), value: n, imports: [], cast: 'int64' }))); break;
            case 'Decimal':
            case 'Money': found.push(...numbers.map(n => ({ go: `decimal.NewFromInt(${n})`, value: n, imports: [DECIMAL] }))); break;
            case 'Bool': found.push(...[true, false].map(b => ({ go: String(b), value: b, imports: [] }))); break;
            case 'String':
            case 'Text': found.push({ go: '""', value: '', imports: [] }); break;
        }
    }
    if (!type.optional) return found;
    return [{ go: 'nil', value: null, imports: [] }, ...found.map(c => ({ ...c, go: `ptr(${c.cast ? `${c.cast}(${c.go})` : c.go})` }))];
}

/** The qualified names the expression compares; a name only tested by `has()` is left out, its null is meant. */
function targets(expr: unknown, found: Set<string> = new Set()): Set<string> {
    if (Array.isArray(expr)) {
        for (const item of expr) targets(item, found);
    } else if (expr && typeof expr === 'object') {
        const node = expr as { $type?: string, target?: unknown, call?: unknown, name?: unknown };
        if (node.$type === 'NameExpr' && node.call && node.name === 'has') return found;
        if (node.$type === 'NameExpr' && typeof node.target === 'string') found.add(node.target);
        for (const value of Object.values(expr)) targets(value, found);
    }
    return found;
}

function defaultValue(field: GraphNode, scope: GoScope): string | undefined {
    const expr = field.data.default as ExprData | undefined;
    if (!expr) return undefined;
    const code = goExpr(expr, scope);
    if (!code) return undefined;
    const value = coerce(code, field);
    return (field.data.type as TypeData).optional ? `ptr(${value})` : value;
}

/** Number literals assigned to decimal fields become decimals. */
function coerce(code: string, field: GraphNode): string {
    const type = field.data.type as TypeData;
    if (!(type.primitive === 'Money' || type.primitive === 'Decimal') || !/^-?[\d.]+$/.test(code)) return code;
    return code.includes('.') ? `decimal.RequireFromString(${JSON.stringify(code)})` : `decimal.NewFromInt(${code})`;
}

function typeOf(type: TypeData, scope: GoScope): string {
    let base = 'any';
    if (type.primitive) {
        const [name, pkg] = PRIMITIVES[type.primitive];
        if (pkg) scope.imports.add(pkg);
        base = name;
    } else if (type.decl) {
        const declaration = scope.node(type.decl)!;
        base = `${declaration.kind === 'Entity' ? '*' : ''}${qualify(declaration, scope)}`;
    }
    if (type.many) return `[]${base}`;
    return type.optional && !base.startsWith('*') ? `*${base}` : base;
}

function goScope(node: GraphNode, context: MapContext, imports: Set<string>): GoScope {
    return { node: context.node, pkg: pkgOf(node.module || node.qn), imports, importOf: module => importPath(module, context), access: accessOf(context) };
}

/**
 * Adds a block to a Go file of a module's package, merging its imports; gofmt formats the result at the end. An
 * external test file belongs to the package `<pkg>_test`, which imports the module's package like any other.
 */
function goFile(module: string, file: string, context: MapContext, imports: Set<string>, block: string, external = false): Step {
    const pkg = external ? `${pkgOf(module)}_test` : pkgOf(module);
    const own = external ? undefined : importPath(module, context);
    return {
        kind: 'template', file: `${dirOf(module)}/${file}`, write: existing => {
            const text = existing ?? `package ${pkg}\n`;
            const match = /^package \w+\n(?:\nimport \(\n([\s\S]*?)\n\)\n)?/.exec(text)!;
            const current = (match[1] ?? '').split('\n').map(l => l.trim().replace(/"/g, '')).filter(Boolean);
            const all = [...new Set([...current, ...imports])].filter(i => i !== own).sort((a, b) => Number(a.includes('.')) - Number(b.includes('.')) || a.localeCompare(b));
            const header = `package ${pkg}\n${all.length ? `\nimport (\n${all.map(i => `\t"${i}"`).join('\n')}\n)\n` : ''}`;
            return `${header}${text.slice(match[0].length).replace(/\s+$/, '')}\n\n${block}\n`;
        }
    };
}

function fieldsOf(node: GraphNode, context: MapContext): GraphNode[] {
    return context.children(node.qn).filter(c => c.kind === 'Field');
}

function importPath(module: string, context: MapContext): string {
    return `${context.name}/${dirOf(module)}`;
}

function dirOf(module: string): string {
    return ['internal', ...module.split('.')].join('/');
}

function pkgOf(module: string): string {
    return module.split('.').pop()!;
}

function errorName(error: GraphNode): string {
    return `Err${pascal(last(error.qn))}`;
}

function parentOf(qn: string): string {
    return qn.slice(0, qn.lastIndexOf('.'));
}

function last(qn: string): string {
    return qn.slice(qn.lastIndexOf('.') + 1);
}

function task(what: string): Step {
    return { kind: 'task', what };
}

/** A registry task the model leaves to the code by design (`docs/concept.md` section 8): it does not lower the coverage. */
function leftToCode(what: string): Step {
    return { kind: 'task', what, leftToCode: true };
}

const coverage = new WeakMap<Graph, Set<string>>();

/** The actions, use cases and transitions the scenarios run; their guessed tests give way to the scenario tests. */
function covered(context: MapContext): Set<string> {
    let found = coverage.get(context.graph);
    if (!found) coverage.set(context.graph, found = coveredByScenarios(context.graph));
    return found;
}

interface AssignmentData { name: string, value: ExprData }
interface FixtureData { name?: string, entity: string, assignments?: AssignmentData[] }
interface CheckData { $type: string, condition?: ExprData, event?: string, assignments?: AssignmentData[] }

/** Why a scenario has no generated test; it becomes the task of the skipped test. */
class Unsupported extends Error {}

/** Names a scenario test declares or reads itself, which a binding must not shadow. */
const GO_NAMES = new Set([
    'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough', 'for', 'func', 'go', 'goto', 'if', 'import',
    'interface', 'map', 'package', 'range', 'return', 'select', 'struct', 'switch', 'type', 'var',
    'any', 'append', 'bool', 'error', 'false', 'int64', 'len', 'make', 'new', 'nil', 'string', 'true',
    't', 'err', 'events', 'event', 'got', 'ok', 'actor', 'ptr', 'decimal', 'errors', 'slices', 'strings', 'regexp', 'testing', 'time'
]);

/**
 * A scenario becomes `TestScenario<Name>` in its module's test file: the given rows built with `New<Entity>`, an
 * ID each, the given values and a sample for every other required field; the actor built with `access.New<Actor>`
 * and its given fields (`access.System()` when the scenario has none, which the actions do not check); one call of
 * the action; and the assertions of `then`. Without a test it stays a skipped test with a registry task.
 */
function scenarioSteps(scenario: GraphNode, context: MapContext): Step[] {
    const name = `TestScenario${pascal(last(scenario.qn))}`;
    const file = 'scenarios_test.go';
    const imports = new Set(['testing']);
    try {
        const lines = scenarioTest(scenario, context, imports);
        const does = scenario.data.does ? `: ${String(scenario.data.does).trim().replace(/\s+/g, ' ')}` : '.';
        const comment = [`// ${name} runs the scenario ${scenario.qn}${does}`];
        const helper = goFile(scenario.module, file, context, new Set(), '// ptr returns a pointer to a copy of v, for optional fields.\nfunc ptr[T any](v T) *T { return &v }', true) as Extract<Step, { kind: 'template' }>;
        return [
            { ...helper, write: existing => existing?.includes('\nfunc ptr[') ? existing : helper.write(existing) },
            goFile(scenario.module, file, context, imports, [...comment, `func ${name}(t *testing.T) {`, ...lines.map(l => `\t${l}`), '}'].join('\n'), true)
        ];
    } catch (error) {
        if (!(error instanceof Unsupported)) throw error;
        const code = `func ${name}(t *testing.T) {\n\tt.Skip(${JSON.stringify(`registry task: ${scenario.qn}`)})\n}`;
        return [goFile(scenario.module, file, context, new Set(['testing']), code, true), task(`write the test ${name}: ${error.message}`)];
    }
}

function scenarioTest(scenario: GraphNode, context: MapContext, imports: Set<string>): string[] {
    const data = scenario.data;
    let result: ReturnType<Simulator['scenario']>;
    try {
        result = simulator(context).scenario(scenario.qn);
    } catch (error) {
        throw new Unsupported(`the simulator cannot run the scenario: ${(error as Error).message}`);
    }
    if (!result.passed) throw new Unsupported(`the simulator does not pass the scenario: ${result.failures.join(' ')}`);
    const call = scenarioCall(scenario);
    const target = context.node(call.target);
    if (!target) throw new Unsupported('the scenario calls nothing the extension knows');
    if (target.kind !== 'Action') throw new Unsupported(`${last(target.qn)} is a ${target.kind === 'UseCase' ? 'use case' : target.kind.toLowerCase()}, which the Go extension leaves to you`);
    const code = actionCode(target, context);
    if (code.tasks.length) throw new Unsupported(`${last(target.qn)} is not fully generated (${code.tasks.map(t => t.kind === 'task' ? t.what : '').join('; ')})`);
    // The test is in the external package `<pkg>_test`, so every name of the module's package is qualified.
    const scope: GoScope = { ...goScope(scenario, context, imports), pkg: `${pkgOf(scenario.module)}_test`, vars: new Map(), rename: new Map() };
    const fixtures = (data.fixtures ?? []) as FixtureData[];
    const reserved = new Set([...GO_NAMES, accessOf(context).pkg, ...context.graph.nodes.filter(n => n.kind === 'Module').map(n => pkgOf(n.qn))]);
    const lines: string[] = [];

    // given: the rows, built as the simulator builds them, each with its own ID so records compare by identity.
    fixtures.forEach((fixture, i) => {
        const entity = context.node(fixture.entity)!;
        let variable = fixture.name ? (reserved.has(fixture.name) ? `${fixture.name}Row` : fixture.name) : `row${i + 1}`;
        while (!fixture.name && fixtures.some(f => f.name === variable)) variable = `${variable}_`;
        const constructor = qualify(entity, scope).replace(/(\w+)$/, 'New$1');
        lines.push(`${variable} := ${constructor}()`, `${variable}.ID = ${i + 1}`);
        const given = new Map((fixture.assignments ?? []).map(a => [a.name, a.value]));
        for (const field of fieldsOf(entity, context).filter(f => !f.data.derived)) {
            const type = field.data.type as TypeData;
            const fieldName = last(field.qn);
            const expr = given.get(fieldName);
            if (expr) {
                const value = valueOf(type, expr, scope);
                if (!value) throw new Unsupported(`the value of ${fieldName} in ${variable} has no Go translation`);
                lines.push(`${variable}.${pascal(fieldName)} = ${value}`);
            } else if (field.data.default) {
                if (!defaultValue(field, { ...scope, imports: new Set(), self: 'x' })) throw new Unsupported(`New${last(entity.qn)} does not set the default of ${fieldName}`);
            } else if (!type.optional && !type.many) {
                const sample = goSample(fieldName, type, scope, context);
                if (sample) lines.push(`${variable}.${pascal(fieldName)} = ${sample.go}`);
            }
        }
        if (fixture.name) {
            scope.vars!.set(fixture.name, 'other');
            if (variable !== fixture.name) scope.rename!.set(fixture.name, variable);
        }
    });

    // as: the declared actor, or the first one carrying the role, with the given fields.
    const persona = data.actor as { persona: string, assignments?: AssignmentData[] } | undefined;
    if (persona) {
        const named = context.node(persona.persona)!;
        const actor = named.kind === 'Role' ? context.graph.nodes.find(n => n.kind === 'Actor' && ((n.data.roles ?? []) as string[]).includes(named.qn)) : named;
        if (!actor) throw new Unsupported(`no declared actor carries the role ${last(named.qn)}`);
        lines.push(`actor := ${accessIn(scope, `New${accessOf(context).name(actor.qn)}`)}()`);
        for (const assignment of persona.assignments ?? []) {
            const field = actorFields(context).find(f => last(f.qn) === assignment.name);
            if (!field || !actorFieldType(field, context, new Set())) throw new Unsupported(`the actor field ${assignment.name} has no form in the access package`);
            const type = field.data.type as TypeData;
            const term = goTerm(assignment.value, scope);
            if (!term || type.many) throw new Unsupported(`the value of the actor field ${assignment.name} has no Go translation`);
            if (term.null) continue;
            const value = type.decl ? `ptr(${term.value}.ID)` : valueOf({ ...type, optional: true }, assignment.value, scope);
            lines.push(`actor.${pascal(assignment.name)} = ${value}`);
        }
        if (!code.takesActor) lines.push('_ = actor');
        scope.actor = 'actor';
        if (code.takesActor && enforced(context)) checkedPolicies(target, code.creates, context);
    }

    // when: the action, with the record first, then the inputs and a create function per created entity that stores nothing.
    const entity = target.data.entity ? context.node(target.data.entity as string) : undefined;
    const given = [...call.args];
    const args: string[] = [];
    if (code.takesActor) args.push(persona ? 'actor' : `${accessIn(scope, 'System')}()`);
    if (entity) {
        const record = given.shift();
        const value = record && valueOf({ $type: 'TypeRef', decl: entity.qn } as TypeData, record, scope);
        if (!value) throw new Unsupported(`the record passed to ${last(target.qn)} has no Go translation`);
        args.push(value);
    }
    for (const param of context.children(target.qn).filter(c => c.kind === 'Param')) {
        const type = param.data.type as TypeData;
        const expr = given.shift();
        const value = expr ? valueOf(type, expr, scope) : type.optional || type.many ? 'nil' : undefined;
        if (!value) throw new Unsupported(`the input ${last(param.qn)} of ${last(target.qn)} has no Go translation`);
        args.push(value);
    }
    for (const created of code.creates) args.push(`func(${typeOf({ $type: 'TypeRef', decl: created.qn } as TypeData, scope)}) error { return nil }`);
    const label = last(target.qn);
    const checks = (data.checks ?? []) as CheckData[];
    const emits = !data.fails && !data.refused && checks.some(c => c.$type === 'Emitted');
    lines.push(`${emits ? 'events' : '_'}, err := ${qualify(target, scope)}(${args.join(', ')})`);

    // then: the error, the refusal, or the checks on the rows (changed in place) and the emitted events.
    if (data.refused) {
        imports.add('errors');
        const forbidden = accessIn(scope, 'ErrForbidden');
        lines.push(`if !errors.Is(err, ${forbidden}) {`, `\tt.Fatalf("${label}: want ${forbidden}, got %v", err)`, '}');
    } else if (data.fails) {
        const error = data.error ? context.node(data.error as string) : undefined;
        if (error || code.takesActor) imports.add('errors');
        if (error) {
            const name = `${qualifyModule(error.module, scope)}.${errorName(error)}`;
            lines.push(`if !errors.Is(err, ${name}) {`, `\tt.Fatalf("${label}: want ${name}, got %v", err)`, '}');
        } else if (code.takesActor) {
            lines.push(`if err == nil || errors.Is(err, ${accessIn(scope, 'ErrForbidden')}) {`, `\tt.Fatalf("${label}: want an error, got %v", err)`, '}');
        } else {
            lines.push('if err == nil {', `\tt.Fatalf("${label}: want an error, got none")`, '}');
        }
    } else {
        lines.push('if err != nil {', `\tt.Fatalf("${label}: %v", err)`, '}');
        const shown = (scenario.props.checks ?? []) as string[];
        checks.forEach((check, i) => lines.push(...checkLines(check, shown[i], scope, context)));
    }
    return lines;
}

/** An expectation as an `if` on the rows, an emitted event as a search through the events the action returns. */
function checkLines(check: CheckData, shown: string, scope: GoScope, context: MapContext): string[] {
    if (check.$type === 'Expectation') {
        const condition = goExpr(check.condition!, scope);
        if (!condition) throw new Unsupported(`the check ${shown} has no Go translation`);
        return [`if !(${condition}) {`, `\tt.Error(${JSON.stringify(`${shown} is false`)})`, '}'];
    }
    const event = context.node(check.event!)!;
    const compared = (check.assignments ?? []).map(a => {
        const field = fieldsOf(event, context).find(f => last(f.qn) === a.name)!;
        const type = field.data.type as TypeData;
        if (type.many || (type.decl && context.node(type.decl)?.kind === 'ValueType')) throw new Unsupported(`the field ${a.name} of ${last(event.qn)} does not compare in Go`);
        const left = { $type: 'MemberExpr', receiver: { $type: 'NameExpr', name: 'got', type: last(event.qn) }, member: a.name, target: field.qn, type: `${type.primitive ?? last(type.decl!)}${type.optional ? '?' : ''}` };
        const same = goExpr({ $type: 'BinaryExpr', op: '==', left, right: a.value, type: 'Bool' } as unknown as ExprData, { ...scope, vars: new Map([...scope.vars ?? [], ['got', 'other']]) });
        if (!same) throw new Unsupported(`the field ${a.name} of ${last(event.qn)} in ${shown} has no Go translation`);
        return same;
    });
    scope.imports.add('slices');
    return [
        'if !slices.ContainsFunc(events, func(event any) bool {',
        `\t${compared.length ? 'got' : '_'}, ok := event.(${qualify(event, scope)})`,
        `\treturn ${['ok', ...compared.map(c => `(${c})`)].join(' && ')}`,
        '}) {',
        `\tt.Error(${JSON.stringify(`${shown} did not happen`)})`,
        '}'
    ];
}

/** A value in Go for a field or an input of the type: lists of records or values as slice literals, the rest as `assigned` says it. */
function valueOf(type: TypeData, expr: ExprData, scope: GoScope): string | undefined {
    if (type.many && expr.$type === 'ListExpr' && expr.items?.length) {
        const items = expr.items.map(item => valueOf({ ...type, many: false, optional: false }, item, scope));
        return items.every(i => i) ? `${typeOf(type, scope)}{${items.join(', ')}}` : undefined;
    }
    return assigned({ data: { type } } as unknown as GraphNode, expr, scope);
}

/** Every policy the simulator weighs for the actor must be one Go checks the same way, and every role condition one Go says. */
function checkedPolicies(action: GraphNode, creates: GraphNode[], context: MapContext): void {
    const entity = action.data.entity as string | undefined;
    const dry = { ...goScope(action, context, new Set()), self: entity && camel(last(entity)), actor: 'actor' };
    const policies = [action.qn, ...(entity ? [entity] : []), ...creates.map(c => c.qn)].flatMap(qn => context.children(qn)).filter(c => c.kind === 'Policy');
    const untranslated = policies.find(p => !goExpr(p.data.condition as ExprData, dry));
    if (untranslated) throw new Unsupported(`the policy ${untranslated.qn} has no Go translation`);
    const role = context.graph.nodes.find(n => n.kind === 'Role' && accessSteps(n, context).some(s => s.kind === 'task'));
    if (role) throw new Unsupported(`the condition of the role ${last(role.qn)} has no Go translation`);
}

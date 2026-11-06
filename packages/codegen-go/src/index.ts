import type { CodegenExtension, MapContext, Step } from '@appling/codegen';
import type { ExprData, GraphNode, TypeData } from '@appling/model';
import { accessFile, accessOf, accessSteps, actorFieldType, tenantOf, tenantPaths } from './access.js';
import { camel, enumConstant, goExpr, pascal, PRIMITIVES, qualify, type GoScope } from './golang.js';

const DECIMAL = 'github.com/shopspring/decimal';
const OPERATIONS = ['read', 'create', 'update', 'delete'];

const extension: CodegenExtension = {
    name: '@appling/codegen-go',
    test: ['go', 'test', './...'],
    syncExclude: ['go.sum'],
    prerequisites: [{ name: 'Go', command: ['go', 'version'], expect: /go1\.(2[2-9]|[3-9]\d)/, hint: 'install Go 1.22 or later' }],

    setup: context => [
        { kind: 'command', run: ['go', 'mod', 'init', context.name], creates: ['go.mod'] },
        { kind: 'command', run: ['go', 'get', `${DECIMAL}@v1.6.0`], creates: ['go.sum'] },
        { kind: 'command', run: ['gofmt', '-w', '.'], phase: 3 }
    ],

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
            case 'Invariant': return [...(validation(node, context) ? [] : [task(`check the invariant "${node.data.label}" in Validate: ${node.props.condition}`)]), ...testSteps(node, context)];
            case 'Policy': return [...policySteps(node, context), ...testSteps(node, context)];
            case 'Role':
            case 'Actor':
            case 'Tenant':
                return accessSteps(node, context);
            case 'Action': return actionSteps(node, context);
            case 'Machine': return machineSteps(node, context);
            case 'Transition': return testSteps(node, context);
            case 'EnumLiteral':
            case 'Param':
            case 'SetEffect':
            case 'CreateEffect':
            case 'EmitEffect':
            case 'ExternalOperation':
            case 'ProjectionField':
            case 'Endpoint':
                return [];
            case 'Query':
            case 'UseCase':
                return [...guardSteps(node, context), task(`implement the ${node.kind.toLowerCase()} ${last(node.qn)} on top of the generated domain package, with the storage, HTTP and scheduling libraries of your choice`)];
            case 'Job':
            case 'Projection':
            case 'External':
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
    return [entityStep(entity, context), ...guardSteps(entity, context)];
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
    const imports = new Set<string>();
    const entity = action.data.entity ? context.node(action.data.entity as string) : undefined;
    const self = entity ? camel(last(entity.qn)) : undefined;
    const scope = { ...goScope(action, context, imports), self };
    const tasks: Step[] = [];
    const body: string[] = ['var events []any'];
    const guard = guardOf(action, context);
    if (guard) {
        imports.add('fmt');
        body.push(`if !${guard.name}(${['actor', ...guard.args].join(', ')}) {`, `\treturn nil, fmt.Errorf("%w: ${last(action.qn)}", ${accessIn(scope, 'ErrForbidden')})`, '}');
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
    if (transitions.length && self) body.push(...transitionSwitch(transitions, self, last(action.qn), scope, context, tasks));
    for (const effect of context.children(action.qn).filter(c => c.kind.endsWith('Effect'))) body.push(...effectLines(effect, self, scope, context, tasks));
    body.push('return events, nil');
    const params = [
        ...(guard ? [`actor ${accessIn(scope, 'Actor')}`] : []),
        ...(entity ? [`${self} ${typeOf({ $type: 'TypeRef', decl: entity.qn } as TypeData, scope)}`] : []),
        ...context.children(action.qn).filter(c => c.kind === 'Param').map(p => `${camel(last(p.qn))} ${typeOf(p.data.type as TypeData, scope)}`)
    ];
    const code = [`// ${last(action.qn)} is the action ${action.qn}. It returns the events it emits.`, `func ${last(action.qn)}(${params.join(', ')}) ([]any, error) {`, ...body.map(l => `\t${l}`), '}'].join('\n');
    return [goFile(action.module, 'actions.go', context, imports, code), ...guardSteps(action, context), ...tasks, ...testSteps(action, context)];
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
 * The exported check of an element, when one applies: `Can<Op><Entity>` for an entity with policies,
 * `Can<Action>` when the action's own policies, its entity's update policies or the tenant guard it, and
 * `Can<Query>` and `Can<UseCase>` for their own policies.
 */
function guardOf(owner: GraphNode, context: MapContext): Guard | undefined {
    const own = policiesOf(owner, context);
    const entityQn = owner.kind === 'Entity' ? owner.qn : owner.data.entity as string | undefined;
    const entity = entityQn ? context.node(entityQn) : undefined;
    const applies = own.length > 0 || (owner.kind === 'Action' && !!entity && (policiesOf(entity, context).length > 0 || tenantPaths(context).has(entity.qn)));
    if (!applies) return undefined;
    const params = owner.kind === 'Action' || owner.kind === 'UseCase' ? context.children(owner.qn).filter(c => c.kind === 'Param') : [];
    return { entity, params, args: [...(entity ? [camel(last(entity.qn))] : []), ...params.map(p => camel(last(p.qn)))], name: `Can${last(owner.qn)}` };
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
 * or a query, the update or read check of its entity, or the tenant) with `&&`. An entity gets one per operation,
 * false where no policy grants it, and one per operation and field that a field policy narrows.
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
        const inherited = entity && owner.kind !== 'UseCase' && policiesOf(entity, context).length
            ? [`${entity.module === owner.module ? '' : `${qualifyModule(entity.module, scope)}.`}Can${op}${last(entity.qn)}(actor, ${record})`]
            : tenant ? [tenant] : [];
        const what = owner.kind === 'Query' ? `read a record through ${owner.qn}` : `run ${owner.qn}`;
        blocks.push([
            `// ${guard.name} reports whether the actor may ${what}${inherited.length ? `, including the ${inherited[0] === tenant ? 'tenant' : op.toLowerCase()} check of ${entity!.qn}` : ''}.`,
            `func ${guard.name}(${signature}) bool {`, `\treturn ${[...inherited, ...policies.map(call)].join(' && ')}`, '}'
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

function transitionSwitch(transitions: GraphNode[], self: string, label: string, scope: GoScope, context: MapContext, tasks: Step[]): string[] {
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
        for (const effect of context.children(transition.qn)) lines.push(...effectLines(effect, self, scope, context, tasks).map(l => `\t${l}`));
        lines.push(`\t${state} = ${enumConstant(context.node(`${enumNode.qn}.${transition.data.to}`)!, scope)}`);
    }
    scope.imports.add('fmt');
    scope.imports.add(scope.importOf(machine.module));
    const invalid = machine.module.split('.').pop() === scope.pkg ? 'ErrInvalidTransition' : `${machine.module.split('.').pop()}.ErrInvalidTransition`;
    lines.push('default:', `\treturn nil, fmt.Errorf("%w: ${label} from %s", ${invalid}, ${state})`, '}');
    return lines;
}

function effectLines(effect: GraphNode, self: string | undefined, scope: GoScope, context: MapContext, tasks: Step[]): string[] {
    if (effect.kind === 'SetEffect') {
        const field = context.node(effect.data.field as string)!;
        const value = goExpr(effect.data.value as ExprData, scope);
        if (!value || !self) {
            tasks.push(task(`apply the effect set ${last(field.qn)} = ${effect.props.value}`));
            return [];
        }
        const code = coerce(value, field);
        return [`${self}.${pascal(last(field.qn))} = ${(field.data.type as TypeData).optional ? `ptr(${code})` : code}`];
    }
    if (effect.kind === 'EmitEffect') {
        const event = context.node(effect.data.event as string)!;
        const assignments = ((effect.data.assignments ?? []) as { name: string, value: ExprData }[]).map(a => [a.name, goExpr(a.value, scope)]);
        if (assignments.some(([, v]) => !v)) {
            tasks.push(task(`emit ${last(event.qn)}`));
            return [];
        }
        return [`events = append(events, ${qualify(event, scope)}{${assignments.map(([n, v]) => `${pascal(n!)}: ${v}`).join(', ')}})`];
    }
    tasks.push(task(`apply the effect ${last(effect.qn)}, for example through your storage layer`));
    return [];
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
    const name = `Test${pascal(last(parentOf(node.qn)))}${pascal(String(node.data.label ?? last(node.qn)).replace(/[^A-Za-z0-9]+/g, '_'))}`.replace(/_/g, '');
    const code = `func ${name}(t *testing.T) {\n\tt.Skip(${JSON.stringify(`registry task: ${node.qn}`)})\n}`;
    return [goFile(node.module, `${pkgOf(node.module)}_test.go`, context, new Set(['testing']), code), task(`write the test ${name}`)];
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

/** Adds a block to a Go file of a module's package, merging its imports; gofmt formats the result at the end. */
function goFile(module: string, file: string, context: MapContext, imports: Set<string>, block: string): Step {
    const pkg = pkgOf(module);
    const own = importPath(module, context);
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

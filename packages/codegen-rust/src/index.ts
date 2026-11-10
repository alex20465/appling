import type { CodegenExtension, MapContext, Step } from '@appling/codegen';
import { coveredByScenarios, durationMs, scenarioCall, Simulator, throughPath, UNKNOWN, type Actor as SimActor, type ExprData, type Graph, type GraphNode, type Record as SimRecord, type TypeData, type Value } from '@appling/model';
import { accessFile, accessOf, accessSteps, actorFields, actorFieldType, durationAttribute, durationSteps, libStep, PRIMITIVES, roleCondition, tenantOf, tenantPaths } from './access.js';
import { enumVariant, pascal, qualify, rustExpr, rustTerm, snake, type RustScope } from './rust.js';

const OPERATIONS = ['read', 'create', 'update', 'delete'];

const DERIVE = '#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]';

const extension: CodegenExtension = {
    name: '@appling/codegen-rust',
    test: ['cargo', 'test'],
    syncExclude: ['target/**', 'Cargo.lock'],
    prerequisites: [{ name: 'Rust', command: ['cargo', '--version'], expect: /cargo 1\.(8[5-9]|9\d|\d{3})/, hint: 'install Rust 1.85 or later' }],

    setup: context => [
        { kind: 'command', run: ['cargo', 'init', '--lib', '--vcs', 'none', '--name', crate(context)], creates: ['Cargo.toml', 'src/lib.rs'] },
        { kind: 'command', run: ['cargo', 'add', 'serde', '--features', 'derive'] },
        { kind: 'command', run: ['cargo', 'add', 'rust_decimal', '--features', 'serde'] },
        { kind: 'command', run: ['cargo', 'add', 'chrono', '--features', 'serde'] }
    ],

    steps(node, context) {
        switch (node.kind) {
            case 'Module': return moduleSteps(node, context);
            case 'Enum': return [append(node.module, enumBlock(node, context))];
            case 'ValueType': return [append(node.module, structBlock(node, context, `The value type ${node.qn}.`)), ...storedDurations(node, context)];
            case 'Event': return [
                append(node.module, structBlock(node, context, `The event ${node.qn}.`)),
                ...storedDurations(node, context),
                rustFile(node.module, text => text.replace(/(pub enum Event \{[\s\S]*?)(\n\})/, (_, head, end) => `${head}\n    ${last(node.qn)}(${last(node.qn)}),${end}`))
            ];
            case 'ErrorDecl': return [rustFile(node.module, text => text.includes(`    ${last(node.qn)},\n`) ? text : text.replace(/(pub enum Error \{[\s\S]*?)(\n\})/, (_, head, end) => `${head}\n    ${last(node.qn)},${end}`))];
            case 'Entity': return [append(node.module, entityBlock(node, context)), ...storedDurations(node, context), ...guardSteps(node, context)];
            case 'Field': return fieldSteps(node, context);
            case 'Invariant': return [...(validation(node, context) ? [] : [task(`check the invariant "${node.data.label}" in validate: ${node.props.condition}`)]), ...invariantTestSteps(node, context)];
            case 'Policy': return [...policySteps(node, context), ...policyTestSteps(node, context)];
            case 'Role':
            case 'Actor':
            case 'Tenant':
                return accessSteps(node, context);
            case 'Action': return actionSteps(node, context);
            case 'Machine': return machineSteps(node, context);
            case 'Transition': return node.data.after !== undefined ? timedTestSteps(node, context) : transitionTestSteps(node, context);
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
            case 'Query': return [...guardSteps(node, context), ...queryFilterSteps(node, context), task(`implement the query ${last(node.qn)} on top of the generated domain module, with the storage, HTTP and scheduling crates of your choice`)];
            case 'UseCase':
                return [...guardSteps(node, context), task(`implement the use case ${last(node.qn)} on top of the generated domain module, with the storage, HTTP and scheduling crates of your choice`)];
            case 'External':
                return [leftToCode(`implement a client for ${last(node.qn)} with the HTTP library of your choice`)];
            case 'Job':
            case 'Projection':
            case 'Interface':
            case 'Page':
            case 'Navigation':
            case 'Flow':
            case 'Messages':
                return [task(`implement the ${node.kind.toLowerCase()} ${last(node.qn)} on top of the generated domain module, with the storage, HTTP and scheduling crates of your choice`)];
            default: return undefined;
        }
    }
};

export default extension;

/** A module becomes `src/<module>.rs` with its error and event enums and a test module, declared by its parent. */
function moduleSteps(module: GraphNode, context: MapContext): Step[] {
    const parent = module.qn.includes('.') ? `src/${module.qn.slice(0, module.qn.lastIndexOf('.')).replaceAll('.', '/')}.rs` : 'src/lib.rs';
    const declare = `pub mod ${last(module.qn)};`;
    const start = [
        `//! The module ${module.qn} of the model.`,
        '',
        '/// The errors of this module\'s actions.',
        '#[derive(Debug, Clone, PartialEq)]',
        'pub enum Error {',
        '    InvalidTransition { action: &\'static str, from: String },',
        '    Forbidden { action: &\'static str },',
        '    /// A precondition without a declared error does not hold.',
        '    Precondition { action: &\'static str, condition: &\'static str },',
        '}',
        '',
        'impl std::fmt::Display for Error {',
        '    fn fmt(&self, f: &mut std::fmt::Formatter<\'_>) -> std::fmt::Result {',
        '        write!(f, "{self:?}")',
        '    }',
        '}',
        '',
        'impl std::error::Error for Error {}',
        '',
        '/// The events this module\'s actions emit.',
        '#[derive(Debug, Clone, PartialEq)]',
        'pub enum Event {',
        '}',
        '',
        '#[cfg(test)]',
        'mod tests {',
        '}',
        ''
    ].join('\n');
    return [
        parent === 'src/lib.rs' ? libStep(context, declare) : { kind: 'template', file: parent, write: existing => !existing || existing.includes('pub fn add(') ? `//! The ${crate(context)} model, generated by Appling.\n\n${declare}\n` : existing.includes(declare) ? existing : `${existing.trimEnd()}\n${declare}\n` },
        rustFile(module.qn, existing => existing || start)
    ];
}

function enumBlock(node: GraphNode, context: MapContext): string {
    const variants = context.children(node.qn).flatMap(l => [`    #[serde(rename = ${JSON.stringify(last(l.qn))})]`, `    ${pascal(last(l.qn))},`]);
    return [`/// The enum ${node.qn}.`, '#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]', `pub enum ${last(node.qn)} {`, ...variants, '}'].join('\n');
}

function structBlock(node: GraphNode, context: MapContext, doc: string): string {
    const scope = rustScope(node, context);
    const fields = fieldsOf(node, context).filter(f => !f.data.derived).flatMap(f => fieldLines(f, scope));
    return [`/// ${doc}`, DERIVE, `pub struct ${last(node.qn)} {`, ...fields, '}'].join('\n');
}

/** A stored field of a struct, after its serde attribute when it holds a duration. */
function fieldLines(field: GraphNode, scope: RustScope): string[] {
    const type = field.data.type as TypeData;
    const attribute = durationAttribute(type);
    return [...(attribute ? [`    ${attribute}`] : []), `    pub ${last(field.qn)}: ${typeOf(type, scope)},`];
}

/** The serde helper for durations, when a stored field of the struct holds one. */
function storedDurations(node: GraphNode, context: MapContext): Step[] {
    return durationSteps(context, fieldsOf(node, context).filter(f => !f.data.derived).map(f => f.data.type as TypeData));
}

/** An entity becomes a struct with an id, `new` taking the fields without default, methods for derived fields, and `validate`. */
function entityBlock(entity: GraphNode, context: MapContext): string {
    const name = last(entity.qn);
    const scope = rustScope(entity, context);
    const fields = fieldsOf(entity, context);
    const stored = fields.filter(f => !f.data.derived);
    const required = requiredFields(entity, context, scope);
    const lines = [`/// The entity ${entity.qn}.`, DERIVE, `pub struct ${name} {`, '    pub id: i64,', ...stored.flatMap(f => fieldLines(f, scope)), '}', '', `impl ${name} {`];
    const initial = stored.map(f => {
        const type = f.data.type as TypeData;
        const fallback = defaultValue(f, scope);
        const value = fallback ?? (type.many ? 'Vec::new()' : type.optional ? 'None' : last(f.qn));
        return value === last(f.qn) ? `            ${value},` : `            ${last(f.qn)}: ${value},`;
    });
    lines.push(
        `    /// A new ${name} with the defaults of the model; the arguments are the fields without one.`,
        `    pub fn new(${required.map(f => `${last(f.qn)}: ${typeOf(f.data.type as TypeData, scope)}`).join(', ')}) -> Self {`,
        '        Self {',
        '            id: 0,',
        ...initial,
        '        }',
        '    }'
    );
    for (const field of fields.filter(f => f.data.derived)) {
        const code = rustExpr(field.data.derived as ExprData, { ...scope, self: 'self' });
        if (code) lines.push('', `    /// The derived field ${field.qn}.`, `    pub fn ${last(field.qn)}(&self) -> ${typeOf(field.data.type as TypeData, scope)} {`, `        ${coerce(code, field)}`, '    }');
    }
    const checks = context.children(entity.qn).filter(n => n.kind === 'Invariant').flatMap(invariant => {
        const condition = validation(invariant, context);
        return condition ? [`        if !(${condition}) {`, `            errors.push(${JSON.stringify(String(invariant.data.label))});`, '        }'] : [];
    });
    lines.push(
        '',
        `    /// Checks the invariants of ${name} and returns the labels of those that do not hold.`,
        '    pub fn validate(&self) -> Result<(), Vec<&\'static str>> {',
        `        let ${checks.length ? 'mut ' : ''}errors = Vec::new();`,
        ...checks,
        '        if errors.is_empty() { Ok(()) } else { Err(errors) }',
        '    }',
        '}'
    );
    const path = tenantPaths(context).get(entity.qn);
    if (path) {
        const tenant = tenantOf(context)!;
        const hops = path.map(f => (f.data.type as TypeData).optional ? `${last(f.qn)}.as_ref()?` : last(f.qn));
        lines.push(
            '',
            `impl ${accessPath(scope, 'Tenanted')} for ${name} {`,
            `    /// The id of the ${tenant.data.entity} this ${name} belongs to, for the tenant ${tenant.qn}.`,
            '    fn tenant_id(&self) -> Option<i64> {',
            `        Some(${['self', ...hops].join('.')}.id)`,
            '    }',
            '}'
        );
    }
    return lines.join('\n');
}

/** The stored fields that `new` takes: required, not lists, and without a default Rust can say. */
function requiredFields(entity: GraphNode, context: MapContext, scope: RustScope): GraphNode[] {
    return fieldsOf(entity, context).filter(f => {
        const type = f.data.type as TypeData;
        return !f.data.derived && !type.optional && !type.many && !defaultValue(f, scope);
    });
}

function fieldSteps(field: GraphNode, context: MapContext): Step[] | undefined {
    const owner = context.node(parentOf(field.qn))!;
    if (owner.kind === 'Event' || owner.kind === 'ValueType') return [];
    if (owner.kind === 'Actor') return actorFieldType(field, context) ? [] : [task(`add the field ${last(field.qn)} of ${owner.qn} to the Actor of the access module; enums and value types have no form there yet`)];
    if (owner.kind !== 'Entity') return undefined;
    const scope = { ...rustScope(owner, context), self: 'self' };
    const tasks: Step[] = [];
    if (field.data.derived && !rustExpr(field.data.derived as ExprData, scope)) tasks.push(task(`implement the derived field ${last(field.qn)} = ${field.props.derived}`));
    if (field.data.default && !defaultValue(field, scope)) tasks.push(task(`set the default of ${last(field.qn)} to ${field.props.default} in ${last(owner.qn)}::new`));
    return tasks;
}

function validation(invariant: GraphNode, context: MapContext): string | undefined {
    return rustExpr(invariant.data.condition as ExprData, { ...rustScope(context.node(parentOf(invariant.qn))!, context), self: 'self' });
}

/**
 * An action becomes a function on `&mut` its entity: preconditions, the state transition, effects, and the emitted
 * events. Its guessed test is left out when a scenario calls the action; the scenario's test replaces it.
 */
function actionSteps(action: GraphNode, context: MapContext): Step[] {
    const { code, tasks } = actionCode(action, context);
    return [append(action.module, code), ...guardSteps(action, context), ...tasks, ...(covered(context).has(action.qn) ? [] : testSteps(action))];
}

/** The function of an action, the tasks for what Rust cannot say in it, and the entities it creates through `create_<entity>`. */
function actionCode(action: GraphNode, context: MapContext): { code: string, tasks: Step[], creating: Creating } {
    const entity = action.data.entity ? context.node(action.data.entity as string) : undefined;
    const self = entity ? snake(last(entity.qn)) : undefined;
    const scope = { ...rustScope(action, context), self };
    const tasks: Step[] = [];
    const body: string[] = [];
    const guard = guardOf(action, context);
    if (guard) body.push(`if !${guard.name}(${guardArgs(guard, 'action', context)}) {`, `    return Err(Error::Forbidden { action: ${JSON.stringify(last(action.qn))} });`, '}');
    ((action.data.preconditions ?? []) as { condition: ExprData, error?: string }[]).forEach((precondition, i) => {
        const condition = rustExpr(precondition.condition, scope);
        const text = (action.props.preconditions as string[])[i];
        if (!condition) {
            tasks.push(task(`check the precondition ${text} in ${last(action.qn)}`));
            return;
        }
        const error = precondition.error ? `Error::${last(precondition.error)}` : `Error::Precondition { action: ${JSON.stringify(last(action.qn))}, condition: ${JSON.stringify(text)} }`;
        body.push(`if !(${condition}) {`, `    return Err(${error});`, '}');
    });
    const transitions = context.graph.nodes.filter(n => n.kind === 'Transition' && n.data.action === action.qn);
    const creating = storing(action);
    if (transitions.length && self) body.push(...transitionMatch(transitions, self, last(action.qn), scope, context, tasks, creating));
    body.push(...effectBlock(action, self, scope, context, tasks, creating));
    const emits = body.some(l => l.includes('events.push('));
    const params = context.children(action.qn).filter(c => c.kind === 'Param').map(p => {
        const used = body.some(l => new RegExp(`\\b${last(p.qn)}\\b`).test(l));
        return `${used ? '' : '_'}${last(p.qn)}: ${typeOf(p.data.type as TypeData, scope)}`;
    });
    const actor = guard || enforced(context) ? [`${body.some(l => /\bactor\b/.test(l)) ? '' : '_'}actor: &${accessPath(scope, 'Actor')}`] : [];
    const stores = storeFunctions(creating).map(([name, e, verb]) => `${name}: &mut dyn FnMut(${verb === 'create' ? '' : '&'}${qualify(e, scope)}) -> Result<(), Error>`);
    const code = [
        `/// The action ${action.qn}. It returns the events it emits.${stores.length ? ' The records it creates, updates or deletes go to the store functions, which write them.' : ''}`,
        `pub fn ${snake(last(action.qn))}(${[...actor, ...(entity ? [`${self}: &mut ${qualify(entity, scope)}`] : []), ...params, ...stores].join(', ')}) -> Result<Vec<Event>, Error> {`,
        `    let ${emits ? 'mut ' : ''}events = Vec::new();`,
        ...body.map(l => `    ${l}`),
        '    Ok(events)',
        '}'
    ].join('\n');
    return { code, tasks, creating };
}

/** Whether an action's function takes the actor: when a check guards it or the model has any policy. */
function takesActor(action: GraphNode, context: MapContext): boolean {
    return !!guardOf(action, context) || enforced(context);
}

/**
 * `in_<query>`: whether a record is among the query's results for its inputs, by the filter. Loading, sorting and
 * paging stay with the storage, the query's task; nothing when the filter does not translate.
 */
function queryFilterSteps(query: GraphNode, context: MapContext): Step[] {
    if (!query.data.filter) return [];
    const entity = context.node(query.data.entity as string)!;
    const self = snake(last(entity.qn));
    const scope = { ...rustScope(query, context), self };
    const condition = rustExpr(query.data.filter as ExprData, scope);
    if (!condition) return [];
    const used = (name: string) => new RegExp(`\\b${name}\\b`).test(condition) ? name : `_${name}`;
    const inputs = context.children(query.qn).filter(c => c.kind === 'Param');
    const params = [
        `${used(self)}: &${qualify(entity, scope)}`,
        ...inputs.map(p => `${used(last(p.qn))}: ${borrowed(p, context) ? `&${qualify(context.node((p.data.type as TypeData).decl!)!, scope)}` : typeOf(p.data.type as TypeData, scope)}`)
    ];
    return [append(query.module, [
        `/// Whether a record is among the results of the query ${query.qn}${inputs.length ? ' for the inputs' : ''}.`,
        `pub fn in_${snake(last(query.qn))}(${params.join(', ')}) -> bool {`,
        `    ${condition}`,
        '}'
    ].join('\n'))];
}

/** What the policy checks of an element receive besides the actor: the record they guard and the inputs. */
interface Guard {
    /** The guarded record's entity: the entity itself, or the entity of the action or query. */
    entity?: GraphNode;
    params: GraphNode[];
    /** The public check, such as `can_place_order`. */
    name: string;
}

/**
 * The public check of an element, when one applies. Once the model has any policy, every entity gets
 * `can_<op>_<entity>`, every action `can_<action>` (its entity's update check and its own policies; an action
 * without an entity that only creates records leaves the check to the create check of the created entity),
 * and every query `can_<query>` (its entity's read check and its own policies); what no policy covers is
 * denied. A use case gets `can_<use case>` for its own policies. Without policies, only the tenant guards actions.
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
    return { entity, params, name: `can_${snake(last(owner.qn))}` };
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

/** A parameter that a check borrows: a single, required record. Everything else is passed by value. */
function borrowed(param: GraphNode, context: MapContext): boolean {
    const type = param.data.type as TypeData;
    return !!type.decl && !type.many && !type.optional && context.node(type.decl)?.kind === 'Entity';
}

/** The parameters of a check, with `_` before those the body does not read. */
function guardSignature(guard: Guard, scope: RustScope, context: MapContext, body: string): string {
    const used = (name: string) => new RegExp(`\\b${name}\\b`).test(body) ? name : `_${name}`;
    return [
        `${used('actor')}: &${accessPath(scope, 'Actor')}`,
        ...(guard.entity ? [`${used(snake(last(guard.entity.qn)))}: &${qualify(guard.entity, scope)}`] : []),
        ...guard.params.map(p => `${used(last(p.qn))}: ${borrowed(p, context) ? `&${qualify(context.node((p.data.type as TypeData).decl!)!, scope)}` : typeOf(p.data.type as TypeData, scope)}`)
    ].join(', ');
}

/** The arguments of a call to a check: from an action, which holds the inputs by value, or from another check. */
function guardArgs(guard: Guard, from: 'action' | 'check', context: MapContext): string {
    return [
        'actor',
        ...(guard.entity ? [snake(last(guard.entity.qn))] : []),
        ...guard.params.map(p => borrowed(p, context) ? (from === 'action' ? `&${last(p.qn)}` : last(p.qn)) : `${last(p.qn)}.clone()`)
    ].join(', ');
}

/**
 * The public checks of an element, combining its policies (and, for an action or a query, the update or read
 * check of its entity, or the tenant) with `&&`, false when there is nothing to combine. An entity gets one per
 * operation, false where no policy grants it, and one per operation and field that a field policy narrows.
 */
function guardSteps(owner: GraphNode, context: MapContext): Step[] {
    const guard = guardOf(owner, context);
    if (!guard) return [];
    const scope = rustScope(owner, context);
    const args = guardArgs(guard, 'check', context);
    const record = guard.entity && snake(last(guard.entity.qn));
    const tenant = guard.entity && tenantPaths(context).has(guard.entity.qn) ? `${accessPath(scope, 'in_tenant')}(actor, ${record})` : undefined;
    const policies = policiesOf(owner, context);
    const call = (policy: GraphNode) => `${policyName(policy, context)}(${args})`;
    const check = (doc: string, name: string, parts: string[]) => {
        const body = parts.join(' && ');
        return [`/// ${doc}`, `pub fn ${name}(${guardSignature(guard, scope, context, body)}) -> bool {`, `    ${body}`, '}'].join('\n');
    };
    const blocks: string[] = [];
    if (owner.kind === 'Entity') {
        const name = snake(last(owner.qn));
        for (const op of OPERATIONS) {
            const covering = policies.filter(p => covers(p, op) && !(p.data.fields as string[] | undefined)?.length);
            blocks.push(check(
                `Whether the policies of ${owner.qn} let the actor ${op} the record${covering.length ? '' : `; no policy grants ${op}`}.`,
                `can_${op}_${name}`,
                covering.length ? [...(tenant ? [tenant] : []), ...covering.map(call)] : ['false']
            ));
            const fields = [...new Set(policies.filter(p => covers(p, op)).flatMap(p => (p.data.fields ?? []) as string[]))];
            for (const field of fields) {
                const narrowing = policies.filter(p => covers(p, op) && ((p.data.fields ?? []) as string[]).includes(field));
                blocks.push(check(`Whether the actor may ${op} the field ${last(field)} of the record.`, `can_${op}_${name}_${last(field)}`, [`can_${op}_${name}(${args})`, ...narrowing.map(call)]));
            }
        }
    } else {
        const op = owner.kind === 'Query' ? 'read' : 'update';
        const entity = guard.entity;
        const inherited = entity && owner.kind !== 'UseCase' && enforced(context)
            ? [`${entity.module === owner.module ? '' : `crate::${entity.module.replaceAll('.', '::')}::`}can_${op}_${snake(last(entity.qn))}(actor, ${record})`]
            : tenant ? [tenant] : [];
        const what = owner.kind === 'Query' ? `read a record through ${owner.qn}` : `run ${owner.qn}`;
        const parts = [...inherited, ...policies.map(call)];
        blocks.push(check(`Whether the actor may ${what}${inherited.length ? `, including the ${inherited[0] === tenant ? 'tenant' : op} check of ${entity!.qn}` : ''}${parts.length ? '' : '; no policy grants it'}.`, guard.name, parts.length ? parts : ['false']));
    }
    return [append(owner.module, blocks.join('\n\n')), ...accessFile(context, accessOf(context))];
}

/** One function per policy, `<owner>_policy_<operations>`, with the arguments of its element's check; false with a task when Rust cannot say the condition. */
function policySteps(policy: GraphNode, context: MapContext): Step[] {
    const guard = guardOf(context.node(parentOf(policy.qn))!, context)!;
    const scope: RustScope = { ...rustScope(policy, context), self: guard.entity && snake(last(guard.entity.qn)), actor: 'actor' };
    const condition = rustExpr(policy.data.condition as ExprData, scope);
    const name = policyName(policy, context);
    const body = condition ?? 'false';
    const code = [
        `/// The policy ${policy.qn}: ${policy.props.condition}`,
        `fn ${name}(${guardSignature(guard, scope, context, body)}) -> bool {`,
        `    ${body}`,
        '}'
    ].join('\n');
    return [append(policy.module, code), ...(condition ? [] : [task(`implement the policy ${policy.qn} in ${name}: ${policy.props.condition}`)])];
}

function policyName(policy: GraphNode, context: MapContext): string {
    const owner = parentOf(policy.qn);
    const words = /\[(.*)\]$/.exec(policy.qn)![1].split(/[^A-Za-z0-9]+/).filter(Boolean).map(w => `_${snake(w)}`).join('');
    const same = policiesOf(context.node(owner)!, context).filter(p => p.qn === policy.qn);
    return `${snake(last(owner))}_policy${words}${same.length > 1 ? `_${same.indexOf(policy) + 1}` : ''}`;
}

function covers(policy: GraphNode, op: string): boolean {
    const operations = policy.data.operations as string[] | undefined;
    return !operations?.length || operations.includes(op);
}

/** A path into the access module. */
function accessPath(scope: RustScope, name: string): string {
    return `crate::${scope.access!.module}::${name}`;
}

function transitionMatch(transitions: GraphNode[], self: string, label: string, scope: RustScope, context: MapContext, tasks: Step[], creating?: Creating): string[] {
    const machine = context.node(parentOf(transitions[0].qn))!;
    const field = context.node(machine.data.field as string)!;
    const enumNode = context.node((field.data.type as TypeData).decl!)!;
    const state = `${self}.${last(field.qn)}`;
    const lines = [`match ${state} {`];
    for (const transition of transitions) {
        const from = (transition.data.from as string[]).map(s => enumVariant(context.node(`${enumNode.qn}.${s}`)!, scope)).join(' | ');
        let pattern = from;
        if (transition.data.guard) {
            const guard = rustExpr(transition.data.guard as ExprData, scope);
            if (guard) pattern = `${from} if ${guard}`;
            else tasks.push(task(`check the guard ${transition.props.guard} of ${last(transition.qn)}`));
        }
        lines.push(`    ${pattern} => {`);
        lines.push(...effectBlock(transition, self, scope, context, tasks, creating).map(l => `        ${l}`));
        lines.push(`        ${state} = ${enumVariant(context.node(`${enumNode.qn}.${transition.data.to}`)!, scope)};`, '    }');
    }
    lines.push(`    _ => return Err(Error::InvalidTransition { action: ${JSON.stringify(label)}, from: format!("{:?}", ${state}) }),`, '}');
    return lines;
}

/**
 * The records an action writes besides its own: each created, updated or deleted entity becomes a `create_<entity>`,
 * `update_<entity>` or `delete_<entity>` function parameter that stores the change.
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
function storeFunctions(creating: Creating): [string, GraphNode, 'create' | 'update' | 'delete'][] {
    return ([['create', creating.entities], ['update', creating.updates], ['delete', creating.deletes]] as const)
        .flatMap(([verb, map]) => [...map.values()].map(e => [`${verb}_${snake(last(e.qn))}`, e, verb] as [string, GraphNode, 'create' | 'update' | 'delete']));
}

/** The effects below an action, a transition or a loop in order; an `as` name is a variable for the effects after it. */
function effectBlock(owner: GraphNode, self: string | undefined, scope: RustScope, context: MapContext, tasks: Step[], creating?: Creating): string[] {
    const lines: string[] = [];
    let current = scope;
    for (const effect of context.children(owner.qn).filter(c => c.kind.endsWith('Effect'))) {
        lines.push(...effectLines(effect, self, current, context, tasks, creating));
        const variable = effect.data.variable as string | undefined;
        if (effect.kind === 'CreateEffect' && variable) current = { ...current, vars: new Map([...(current.vars ?? []), [variable, 'other']]) };
    }
    return lines;
}

function effectLines(effect: GraphNode, self: string | undefined, scope: RustScope, context: MapContext, tasks: Step[], creating?: Creating): string[] {
    if (effect.kind === 'ForEffect') return loopLines(effect, self, scope, context, tasks, creating);
    if (effect.kind === 'UpdateEffect' || effect.kind === 'DeleteEffect') return recordLines(effect, self, scope, context, tasks, creating);
    if (effect.kind === 'SetEffect') {
        const field = context.node(effect.data.field as string)!;
        const value = self && assigned(field, effect.data.value as ExprData, scope);
        if (!value) {
            tasks.push(task(`apply the effect set ${last(field.qn)} = ${effect.props.value}`));
            return [];
        }
        return [`${self}.${last(field.qn)} = ${value};`];
    }
    if (effect.kind === 'EmitEffect') {
        const event = context.node(effect.data.event as string)!;
        const given = new Map(((effect.data.assignments ?? []) as { name: string, value: ExprData }[]).map(a => [a.name, a.value]));
        const values: string[] = [];
        const missing: string[] = [];
        for (const field of fieldsOf(event, context).filter(f => !f.data.derived)) {
            const type = field.data.type as TypeData;
            const expr = given.get(last(field.qn));
            const value = expr ? assigned(field, expr, scope) : type.many ? 'Vec::new()' : type.optional ? 'None' : undefined;
            if (value) values.push(`${last(field.qn)}: ${value}`);
            else missing.push(last(field.qn));
        }
        if (missing.length) {
            tasks.push(task(`emit ${last(event.qn)} with its fields ${missing.join(', ')}, which the model does not give or Rust cannot say`));
            return [];
        }
        const path = event.module === scope.module ? 'Event' : `crate::${event.module.replaceAll('.', '::')}::Event`;
        return [`events.push(${path}::${last(event.qn)}(${qualify(event, scope)} { ${values.join(', ')} }));`];
    }
    if (effect.kind === 'CreateEffect') {
        const entity = context.node(effect.data.entity as string)!;
        const lines = creating && createLines(effect, entity, scope, context, creating);
        if (lines) return lines;
        const check = enforced(context) && runByActor(effect, context)
            ? `, after checking ${entity.module === scope.module ? '' : `crate::${entity.module.replaceAll('.', '::')}::`}can_create_${snake(last(entity.qn))}(actor, &record)`
            : '';
        tasks.push(task(`create the ${last(entity.qn)} through your storage layer${check}`));
        return [];
    }
    tasks.push(task(`apply the effect ${last(effect.qn)}, for example through your storage layer`));
    return [];
}

/**
 * `for x in items` loops over the record's list, by `iter_mut()` when an `update` changes a record the loop
 * variable leads to. A loop that would also borrow the whole record (a method call on it) becomes a task.
 */
function loopLines(effect: GraphNode, self: string | undefined, scope: RustScope, context: MapContext, tasks: Step[], creating?: Creating): string[] {
    const variable = effect.data.variable as string;
    const inner = { ...scope, vars: new Map([...(scope.vars ?? []), [variable, 'other' as const]]) };
    // A dry run decides whether the loop is kept before it registers stores and tasks.
    const draft = self ? effectBlock(effect, self, inner, context, [], creating && { ...creating, entities: new Map(), updates: new Map(), deletes: new Map() }) : [];
    const mutates = context.children(effect.qn).some(c => c.kind === 'UpdateEffect' && rootOf(c.data.target as ExprData) === variable);
    if (!self || (mutates && new RegExp(`\\b${self}\\.\\w+\\(`).test(draft.join('\n')))) {
        tasks.push(task(`apply the effect ${last(effect.qn)}`));
        return [];
    }
    const body = effectBlock(effect, self, inner, context, tasks, creating);
    const used = body.some(l => new RegExp(`\\b${variable}\\b`).test(l));
    return [`for ${used ? variable : '_'} in ${self}.${last(effect.data.collection as string)}.${mutates ? 'iter_mut' : 'iter'}() {`, ...body.map(l => `    ${l}`), '}'];
}

/** The first name of a relationship path, such as `item` in `item.product`. */
function rootOf(path: ExprData | undefined): string | undefined {
    return path?.$type === 'MemberExpr' ? rootOf(path.receiver) : path?.name;
}

/**
 * `update <path>` sets the fields of the related record and hands it to `update_<entity>`, `delete <path>` and
 * `delete self` hand it to `delete_<entity>`; once the model has policies, the actor needs the entity's update
 * or delete check first. An optional record at the end of the path is changed through `if let`; a path through
 * an optional record in the middle, or code outside an action, becomes a task.
 */
function recordLines(effect: GraphNode, self: string | undefined, scope: RustScope, context: MapContext, tasks: Step[], creating?: Creating): string[] {
    const entity = context.node(effect.data.entity as string);
    const operation = effect.kind === 'UpdateEffect' ? 'update' : 'delete';
    const target = effect.data.target as ExprData | undefined;
    const optional = !!target?.type.endsWith('?');
    const through = target && hopsOf(target).slice(0, -1).some(h => h.type.endsWith('?'));
    // An optional record is bound to `record`, so the sets read and write it through that name.
    const path: ExprData | undefined = optional ? { $type: 'NameExpr', name: 'record', type: target!.type.slice(0, -1) } : target;
    const inner = optional ? { ...scope, vars: new Map([...(scope.vars ?? []), ['record', 'other' as const]]) } : scope;
    const code = effect.data.self ? self : path && rustTerm(path, inner)?.raw;
    const outer = optional ? rustTerm(target!, scope)?.raw : code;
    const sets: string[] = [];
    const wanted = operation === 'update' ? context.children(effect.qn).filter(c => c.kind === 'SetEffect') : [];
    for (const set of wanted) {
        const field = context.node(set.data.field as string)!;
        const value = entity && assigned(field, throughPath(set.data.value as ExprData, entity.qn, path!), inner);
        if (!value) break;
        sets.push(`${code}.${last(field.qn)} = ${value};`);
    }
    if (!creating || !entity || !code || !outer || through || sets.length < wanted.length) {
        tasks.push(task(`apply the effect ${last(effect.qn)}: ${operation} ${effect.data.self ? 'self' : effect.props.target}, for example through your storage layer`));
        return [];
    }
    (operation === 'update' ? creating.updates : creating.deletes).set(entity.qn, entity);
    // An `as` name holds the record itself; everything else is a reference or a box to dereference.
    const named = !optional && target?.$type === 'NameExpr' && !target.target && !effect.qn.includes(`.effect[for ${target.name}].`);
    const record = named ? `&${code}` : `&*${code}`;
    const check = enforced(context) ? [
        `if !${entity.module === effect.module ? '' : `crate::${entity.module.replaceAll('.', '::')}::`}can_${operation}_${snake(last(entity.qn))}(actor, ${record}) {`,
        `    return Err(Error::Forbidden { action: ${JSON.stringify(creating.action)} });`,
        '}'
    ] : [];
    const write = [...check, ...sets, `${operation}_${snake(last(entity.qn))}(${record})?;`];
    return optional ? [`if let Some(record) = ${outer}.as_deref_mut() {`, ...write.map(l => `    ${l}`), '}'] : write;
}

/** The names and fields along a path, outermost first: `item`, then `item.product`. */
function hopsOf(path: ExprData): ExprData[] {
    return path.$type === 'MemberExpr' ? [...hopsOf(path.receiver!), path] : [path];
}

/**
 * A create effect in an action: a block that builds the record with `<Entity>::new` and the given fields, checks
 * `can_create_<entity>` once the model has policies, and hands the record to `create_<entity>`. Undefined when a
 * required field without default is not given or a value does not translate.
 */
function createLines(effect: GraphNode, entity: GraphNode, scope: RustScope, context: MapContext, creating: Creating): string[] | undefined {
    const given = new Map(((effect.data.assignments ?? []) as { name: string, value: ExprData }[]).map(a => [a.name, a.value]));
    const required = requiredFields(entity, context, scope);
    const args: string[] = [];
    for (const field of required) {
        const expr = given.get(last(field.qn));
        const value = expr && assigned(field, expr, scope);
        if (!value) return undefined;
        args.push(value);
    }
    // A named row stays a variable for the effects after it, so the store gets a copy; an unnamed one lives in its own block.
    const variable = effect.data.variable as string | undefined;
    const record = variable ?? 'created';
    const sets: string[] = [];
    for (const field of fieldsOf(entity, context).filter(f => !f.data.derived && !required.includes(f))) {
        const expr = given.get(last(field.qn));
        if (!expr) continue;
        const value = assigned(field, expr, scope);
        if (!value) return undefined;
        sets.push(`${record}.${last(field.qn)} = ${value};`);
    }
    const check = enforced(context) ? [
        `if !${entity.module === effect.module ? '' : `crate::${entity.module.replaceAll('.', '::')}::`}can_create_${snake(last(entity.qn))}(actor, &${record}) {`,
        `    return Err(Error::Forbidden { action: ${JSON.stringify(creating.action)} });`,
        '}'
    ] : [];
    creating.entities.set(entity.qn, entity);
    const code = [
        `let ${sets.length || variable ? 'mut ' : ''}${record} = ${qualify(entity, scope)}::new(${args.join(', ')});`,
        ...sets, ...check,
        `create_${snake(last(entity.qn))}(${variable ? `${record}.clone()` : record})?;`
    ];
    return variable ? code : ['{', ...code.map(l => `    ${l}`), '}'];
}

/** Whether an effect runs in an action, which takes the actor, rather than in a transition on an event. */
function runByActor(effect: GraphNode, context: MapContext): boolean {
    let owner = context.node(effect.qn.slice(0, effect.qn.lastIndexOf('.effect[')));
    while (owner?.kind.endsWith('Effect')) owner = context.node(owner.qn.slice(0, owner.qn.lastIndexOf('.effect[')));
    return owner?.kind === 'Action' || (owner?.kind === 'Transition' && !!owner.data.action);
}

/**
 * An expression as the value of a field, owned: paths are cloned (the record is borrowed), records are boxed,
 * an optional field takes an `Option` as it is and a value in `Some`, and number literals become decimals for
 * decimal fields.
 */
function assigned(field: GraphNode, expr: ExprData, scope: RustScope): string | undefined {
    const term = rustTerm(expr, scope);
    if (!term) return undefined;
    const type = field.data.type as TypeData;
    if (term.null) return type.optional && !type.many ? 'None' : undefined;
    if (term.empty) return type.many ? 'Vec::new()' : undefined;
    const owned = (code: string) => /^[a-z_]\w*(\.[a-z_]\w*)*$/.test(code) && !['true', 'false'].includes(code) ? `${code}.clone()` : code;
    if (type.many) return owned(term.value);
    if (type.optional && term.option) return owned(term.raw);
    const entity = !!type.decl && scope.node(type.decl)?.kind === 'Entity';
    const value = entity ? `Box::new((*${term.value}).clone())` : owned(coerce(term.value, field));
    return type.optional ? `Some(${value})` : value;
}

/** Transitions on an event become a function that applies them to the record the event carries. */
function machineSteps(machine: GraphNode, context: MapContext): Step[] {
    const field = context.node(machine.data.field as string)!;
    const entity = context.node(parentOf(field.qn))!;
    const steps: Step[] = [];
    const byEvent = Map.groupBy(context.children(machine.qn).filter(t => t.kind === 'Transition' && t.data.event), t => t.data.event as string);
    for (const [eventQn, transitions] of byEvent) {
        const event = context.node(eventQn)!;
        const carrier = fieldsOf(event, context).find(f => (f.data.type as TypeData).decl === entity.qn);
        if (!carrier) {
            steps.push(task(`apply the transitions of ${last(machine.qn)} on ${last(eventQn)}; the event carries no ${last(entity.qn)}`));
            continue;
        }
        const scope = { ...rustScope(machine, context), self: last(carrier.qn) };
        const tasks: Step[] = [];
        const body = transitionMatch(transitions, scope.self, last(eventQn), scope, context, tasks);
        const emits = body.some(l => l.includes('events.push('));
        const name = `${snake(last(machine.qn))}_on_${snake(last(eventQn))}`;
        steps.push(append(machine.module, [
            `/// Applies the transitions of ${machine.qn} that ${last(eventQn)} triggers.`,
            `pub fn ${name}(event: &mut ${qualify(event, scope)}) -> Result<Vec<Event>, Error> {`,
            `    let ${scope.self} = &mut event.${last(carrier.qn)};`,
            `    let ${emits ? 'mut ' : ''}events = Vec::new();`,
            ...body.map(l => `    ${l}`),
            '    Ok(events)',
            '}'
        ].join('\n')), ...tasks);
    }
    return [...steps, ...timeoutSteps(machine, entity, context)];
}

/** A duration such as `48h` or `1h30m` as a `chrono::TimeDelta`, in the largest unit that divides it. */
function rustDuration(text: string): string | undefined {
    const ms = durationMs(text);
    const unit = ([['days', 86_400_000], ['hours', 3_600_000], ['minutes', 60_000], ['seconds', 1000], ['milliseconds', 1]] as const).find(([, size]) => ms > 0 && ms % size === 0);
    return unit && `chrono::TimeDelta::${unit[0]}(${ms / unit[1]})`;
}

/** The name of a machine's function over its timed transitions. */
function timeoutName(machine: GraphNode): string {
    return `${snake(last(machine.qn))}_timeouts`;
}

/** Whether the date of a timed transition lies the duration back from `now` or longer, in Rust. */
function dueCondition(transition: GraphNode, self: string, context: MapContext): string | undefined {
    const since = context.node(transition.data.since as string)!;
    const type = since.data.type as TypeData;
    const delta = rustDuration(String(transition.data.after));
    if (!delta) return undefined;
    const now = type.primitive === 'Date' ? 'now.date_naive()' : 'now';
    const field = `${self}.${last(since.qn)}`;
    return type.optional ? `${field}.is_some_and(|since| since + ${delta} <= ${now})` : `${field} + ${delta} <= ${now}`;
}

/**
 * The timed transitions of a machine (`after … since …`) become `<machine>_timeouts(record, now)`: the first one
 * whose from state holds, whose date lies the duration back from now or longer and whose guard holds runs its
 * effects and moves the record. It returns the events it emits and whether the record moved; the storage calls it
 * for the rows a periodic sweep selects, the interval being the project's decision (decision 2A on #88).
 */
function timeoutSteps(machine: GraphNode, entity: GraphNode, context: MapContext): Step[] {
    const timed = context.children(machine.qn).filter(t => t.kind === 'Transition' && t.data.after !== undefined);
    if (!timed.length) return [];
    const self = snake(last(entity.qn));
    const scope: RustScope = { ...rustScope(machine, context), self };
    const field = context.node(machine.data.field as string)!;
    const enumNode = context.node((field.data.type as TypeData).decl!)!;
    const state = `${self}.${last(field.qn)}`;
    const tasks: Step[] = [];
    const arms: string[] = [];
    for (const transition of timed) {
        const due = dueCondition(transition, self, context);
        const guard = transition.data.guard ? rustExpr(transition.data.guard as ExprData, scope) : 'true';
        if (!due || !guard) {
            tasks.push(task(`apply the timed transition ${last(transition.qn)} in ${timeoutName(machine)}`));
            continue;
        }
        const from = (transition.data.from as string[]).map(s => enumVariant(context.node(`${enumNode.qn}.${s}`)!, scope)).join(' | ');
        arms.push(
            `    ${from} if ${[due, ...(guard === 'true' ? [] : [`(${guard})`])].join(' && ')} => {`,
            ...effectBlock(transition, self, scope, context, tasks).map(l => `        ${l}`),
            `        ${state} = ${enumVariant(context.node(`${enumNode.qn}.${transition.data.to}`)!, scope)};`,
            '        (events, true)',
            '    }'
        );
    }
    if (!arms.length) return tasks;
    const emits = arms.some(l => l.includes('events.push('));
    const body = [`let ${emits ? 'mut ' : ''}events = Vec::new();`, `match ${state} {`, ...arms, '    _ => (events, false),', '}'];
    return [append(machine.module, [
        `/// Applies the first timed transition of ${machine.qn} that is due at \`now\` to the record. Returns the events it`,
        '/// emits and whether the record moved; a periodic sweep calls it for the rows it selects.',
        `pub fn ${timeoutName(machine)}(${self}: &mut ${qualify(entity, scope)}, now: chrono::DateTime<chrono::Utc>) -> (Vec<Event>, bool) {`,
        ...body.map(l => `    ${l}`),
        '}'
    ].join('\n')), ...tasks];
}

/**
 * The test of a timed transition: the entity's valid record in a from state whose date lies a minute (a day for
 * a Date) past the duration moves to `to`, and the same record dated now stays. The simulator, its clock past
 * the duration, must take this transition with nothing undecided.
 */
function timedTestSteps(transition: GraphNode, context: MapContext): Step[] {
    if (covered(context).has(transition.qn)) return [];
    const machine = context.node(parentOf(transition.qn))!;
    const field = context.node(machine.data.field as string)!;
    const entity = context.node(parentOf(field.qn))!;
    const since = context.node(transition.data.since as string)!;
    const scope = rustScope(transition, context);
    const valid = entity.module === transition.module && machine.module === transition.module ? validRecord(entity, scope, context) : undefined;
    const delta = rustDuration(String(transition.data.after));
    if (!valid || !delta) return testSteps(transition);
    const type = since.data.type as TypeData;
    const date = type.primitive === 'Date';
    const now = new Date();
    const due = new Date(now.getTime() - durationMs(String(transition.data.after)) - (date ? 86_400_000 : 60_000));
    const later = new Simulator(context.graph, now);
    const stateName = last(field.qn);
    const from = (transition.data.from as string[]).find(state => {
        const result = later.elapse(machine.qn, { ...valid.record, [stateName]: state, [last(since.qn)]: due });
        return result?.transition === transition.qn && !result.undecided.length;
    });
    if (!from) return testSteps(transition);
    const enumNode = context.node((field.data.type as TypeData).decl!)!;
    const literal = (s: string) => enumVariant(context.node(`${enumNode.qn}.${s}`)!, scope);
    const today = date ? 'now.date_naive()' : 'now';
    const wrap = (value: string) => type.optional ? `Some(${value})` : value;
    const run = (when: string, moved: boolean, expected: string, label: string) => [
        `    let mut x = ${valid.name}();`,
        `    x.${stateName} = ${literal(from)};`,
        `    x.${last(since.qn)} = ${wrap(when)};`,
        `    let (_, moved) = ${timeoutName(machine)}(&mut x, now);`,
        `    assert!(${moved ? 'moved' : '!moved'} && x.${stateName} == ${expected}, ${JSON.stringify(label)});`
    ];
    const code = [
        '#[test]',
        `fn ${testName(transition)}() {`,
        '    let now = chrono::Utc::now();',
        ...run(`${today} - ${delta} - chrono::TimeDelta::${date ? 'days' : 'minutes'}(1)`, true, literal(transition.data.to as string), `${from} goes to ${transition.data.to} once due`),
        ...run(today, false, literal(from), `${from} stays until due`),
        '}'
    ].join('\n');
    return [valid.step, testBlock(transition.module, code)];
}

/** An ignored test per rule in the module's test module; writing its body is a registry task, with the reason when one is known. */
function testSteps(node: GraphNode, name = testName(node), why?: string): Step[] {
    return [
        rustFile(node.module, text => text.replace(/(#\[cfg\(test\)\]\nmod tests \{\n)([\s\S]*?)(\}\n?$)/, (_, head, body, end) => `${head}${body}    #[test]\n    #[ignore = ${JSON.stringify(`registry task: ${node.qn}`)}]\n    fn ${name}() {}\n${end}`)),
        task(`write the test ${name}${why ? `: ${why}` : ''}`)
    ];
}

const POLICY_CASES = [{ label: 'allows permitted actors', suffix: 'allows_permitted_actors' }, { label: 'denies other actors', suffix: 'denies_other_actors' }];

/**
 * The tests of a policy on a whole entity whose condition reads the actor only through `actor.is(...)`: the
 * entity's valid record and `Actor::<actor>()` of a declared actor go to `can_<op>_<entity>`.
 * `<test>_allows_permitted_actors` takes the first actor the simulator proves this policy lets through and asserts
 * every operation whose whole record policies all read the actor that way and grant it;
 * `<test>_denies_other_actors` takes the first actor the simulator proves this policy keeps out and refutes every
 * operation it covers (the checks combine with `&&`). A case without such an actor stays ignored as a task; field
 * policies, policies on other elements and a condition that reads more of the actor or that Rust cannot say keep
 * the test ignored.
 */
function policyTestSteps(policy: GraphNode, context: MapContext): Step[] {
    const entity = context.node(parentOf(policy.qn));
    if (entity?.kind !== 'Entity' || ((policy.data.fields ?? []) as string[]).length) return testSteps(policy);
    const wholes = policiesOf(entity, context).filter(p => !((p.data.fields ?? []) as string[]).length);
    const record = snake(last(entity.qn));
    const dry: RustScope = { ...rustScope(entity, context), self: record, actor: 'actor' };
    const checkable = (p: GraphNode) => onlyActorKinds(p.data.condition as ExprData, context) && !!rustExpr(p.data.condition as ExprData, dry);
    if (!checkable(policy)) return testSteps(policy);
    const scope = rustScope(policy, context);
    const valid = validRecord(entity, scope, context);
    if (!valid) return testSteps(policy);
    const sim = simulator(context);
    const verdict = (p: GraphNode, actor: GraphNode) => sim.evaluate(p.data.condition as ExprData, { self: valid.record, actor: { actor: actor.qn, fields: {} } });
    const operations = OPERATIONS.filter(op => covers(policy, op));
    const actors = context.graph.nodes.filter(n => n.kind === 'Actor');
    const allowed = actors.map(actor => ({ actor, operations: operations.filter(op => wholes.filter(p => covers(p, op)).every(p => checkable(p) && verdict(p, actor) === true)) }))
        .find(a => verdict(policy, a.actor) === true && a.operations.length);
    const deniedActor = actors.find(actor => verdict(policy, actor) === false);
    const denied = deniedActor && { actor: deniedActor, operations };
    if (!allowed && !denied) return testSteps(policy);
    const name = testName(policy);
    const message = (text: string) => JSON.stringify(text.replace(/\{/g, '{{').replace(/\}/g, '}}'));
    const test = (fn: string, found: { actor: GraphNode, operations: string[] } | undefined, want: boolean) => found ? [
        '#[test]',
        `fn ${fn}() {`,
        `    let actor = ${accessPath(scope, 'Actor')}::${snake(accessOf(context).name(found.actor.qn))}();`,
        `    let ${record} = ${valid.name}();`,
        ...found.operations.map(op => {
            const check = `can_${op}_${record}`;
            return `    assert!(${want ? '' : '!'}${check}(&actor, &${record}), ${message(`${check}: want ${want} for ${found.actor.qn}`)});`;
        }),
        '}'
    ].join('\n') : [
        '#[test]',
        `#[ignore = ${JSON.stringify(`registry task: ${policy.qn}`)}]`,
        `fn ${fn}() {}`
    ].join('\n');
    const [allows, denies] = POLICY_CASES.map(c => `${name}_${c.suffix}`);
    const code = [test(allows, allowed, true), '', test(denies, denied, false)].join('\n');
    const missing = [allowed ? undefined : allows, denied ? undefined : denies].filter(c => c !== undefined);
    return [valid.step, testBlock(policy.module, code), ...missing.map(fn => task(`write the test ${fn}`))];
}

/**
 * Whether the condition reads the actor only through `actor.is(X)` with an X whose verdict needs no actor field
 * (an actor, or a role without a condition), and not the tenant, so `Actor::<actor>()` has the simulated verdict.
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
    return snake(`${last(parentOf(node.qn))}_${String(node.data.label ?? last(node.qn))}`).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/** Adds a block to the test module of a module's file, which then imports the module (`use super::*;`). */
function testBlock(module: string, block: string, glob = true): Step {
    return rustFile(module, text => text.replace(/(#\[cfg\(test\)\]\nmod tests \{\n)([\s\S]*?)(\}\n?$)/, (_, head, body, end) => {
        const uses = !glob || body.startsWith('    use super::*;\n') ? body : `    use super::*;\n\n${body}`;
        return `${head}${uses}${block.split('\n').map(l => l ? `    ${l}` : l).join('\n')}\n${end}`;
    }));
}

const simulators = new WeakMap<Graph, Simulator>();

/** One simulator per graph, which proves that a test record satisfies or breaks an invariant. */
function simulator(context: MapContext): Simulator {
    let found = simulators.get(context.graph);
    if (!found) simulators.set(context.graph, found = new Simulator(context.graph));
    return found;
}

/**
 * The test of an invariant that `validate` checks: the entity's valid record passes `validate`, and the same
 * record with one field the simulator proves to break the invariant fails with its label. Without a valid record
 * the test stays ignored; without such a field value the violation case is a registry task.
 */
function invariantTestSteps(invariant: GraphNode, context: MapContext): Step[] {
    const entity = context.node(parentOf(invariant.qn))!;
    if (!validation(invariant, context)) return testSteps(invariant);
    const scope = rustScope(entity, context);
    const valid = validRecord(entity, scope, context);
    if (!valid) return testSteps(invariant);
    const name = testName(invariant);
    const label = JSON.stringify(String(invariant.data.label));
    const violation = violating(invariant, entity, valid.record, scope, context);
    const message = (text: string, args = '') => JSON.stringify(text.replace(/\{/g, '{{').replace(/\}/g, '}}') + args);
    const code = [
        '#[test]',
        `fn ${name}() {`,
        `    assert_eq!(${valid.name}().validate(), Ok(()), ${message(`a valid ${last(entity.qn)}`)});`,
        ...(violation ? [
            `    let mut x = ${valid.name}();`,
            `    ${violation}`,
            '    let errors = x.validate().unwrap_err();',
            `    assert!(errors.contains(&${label}), ${message(`${violation} breaks ${String(invariant.data.label)}`, ': {errors:?}')});`
        ] : []),
        '}'
    ].join('\n');
    return [valid.step, testBlock(invariant.module, code), ...(violation ? [] : [task(`write the violation case of the test ${name}`)])];
}

/**
 * The test of a transition an action runs: the entity's valid record in a `from` state goes to the `to` state
 * through the action, and, when the action allows a state no transition leaves, the action refuses it with
 * `Error::InvalidTransition`. The simulator must prove that the preconditions and the guard hold and that no
 * earlier arm of the match takes the record; without that (an actor to pass, an input or state it cannot say,
 * code in another module) the test stays ignored as a registry task.
 */
function transitionTestSteps(transition: GraphNode, context: MapContext): Step[] {
    // A scenario that calls the transition's action has the test of it.
    if (covered(context).has(transition.qn)) return [];
    const plan = transitionTest(transition, context);
    if (!plan) return testSteps(transition);
    const { action, valid, state, from, to, invalid, args, actor } = plan;
    const fn = snake(last(action.qn));
    const call = `${fn}(${[...(actor ? ['&actor'] : []), '&mut x', ...args].join(', ')})`;
    const message = (text: string) => JSON.stringify(text.replace(/\{/g, '{{').replace(/\}/g, '}}'));
    const code = [
        '#[test]',
        `fn ${testName(transition)}() {`,
        ...(actor ? [`    let actor = ${actor};`] : []),
        `    let mut x = ${valid.name}();`,
        `    x.${state} = ${from.rust};`,
        `    ${call}.expect(${message(`${fn} from ${from.label}`)});`,
        `    assert_eq!(x.${state}, ${to.rust}, ${message(`${fn} from ${from.label} goes to ${to.label}`)});`,
        ...(invalid ? [
            `    let mut x = ${valid.name}();`,
            `    x.${state} = ${invalid.rust};`,
            `    assert!(matches!(${call}, Err(Error::InvalidTransition { .. })), ${message(`${fn} refuses ${invalid.label}`)});`
        ] : []),
        '}'
    ].join('\n');
    return [valid.step, testBlock(transition.module, code)];
}

interface Literal { rust: string, label: string }

/**
 * Whether every policy the simulator weighs for an action is one Rust checks: those of the action, of its entity
 * and of the entities it creates. Otherwise Rust denies where the simulator allows.
 */
function checksTranslate(action: GraphNode, context: MapContext): boolean {
    const written = storeFunctions(actionCode(action, context).creating).map(([, e]) => e.qn);
    const owners = [action.qn, ...(action.data.entity ? [action.data.entity as string] : []), ...written];
    const entity = action.data.entity ? context.node(action.data.entity as string) : undefined;
    const scope: RustScope = { ...rustScope(action, context), self: entity && snake(last(entity.qn)), actor: 'actor' };
    const roles = context.graph.nodes.filter(n => n.kind === 'Role' && n.data.condition);
    return owners.flatMap(qn => context.children(qn)).filter(c => c.kind === 'Policy').every(p => rustExpr(p.data.condition as ExprData, scope))
        && roles.every(r => roleCondition(r, context));
}

function transitionTest(transition: GraphNode, context: MapContext) {
    const action = transition.data.action ? context.node(transition.data.action as string) : undefined;
    const machine = context.node(parentOf(transition.qn))!;
    const entity = action?.data.entity ? context.node(action.data.entity as string) : undefined;
    if (!action || !entity || !(machine.data.field as string).startsWith(`${entity.qn}.`)) return undefined;
    // Code in another module is more than a generated test sets up.
    if (action.module !== transition.module || entity.module !== transition.module) return undefined;
    const scope = rustScope(transition, context);
    const valid = validRecord(entity, scope, context);
    if (!valid) return undefined;
    const transitions = context.graph.nodes.filter(n => n.kind === 'Transition' && n.data.action === action.qn);
    const self = snake(last(entity.qn));
    const dry: RustScope = { ...rustScope(action, context), self };
    const acting = takesActor(action, context);
    if (acting && !checksTranslate(action, context)) return undefined;
    const args: string[] = [];
    const inputs: { [name: string]: Value } = {};
    for (const param of context.children(action.qn).filter(c => c.kind === 'Param')) {
        const sample = rustSample(last(param.qn), param.data.type as TypeData, scope, context, 0);
        if (!sample || sample.value === UNKNOWN) return undefined;
        args.push(sample.rust);
        inputs[last(param.qn)] = sample.value;
    }
    // The create functions the action takes; the test stores nothing.
    args.push(...storeArgs(action, scope, context));
    const field = context.node(machine.data.field as string)!;
    if ((field.data.type as TypeData).optional) return undefined;
    const enumNode = context.node((field.data.type as TypeData).decl!)!;
    const literal = (value: string): Literal => ({ rust: enumVariant(context.node(`${enumNode.qn}.${value}`)!, scope), label: value });
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
            if (t === transition) return verdict === true && (!t.data.guard || !!rustExpr(t.data.guard as ExprData, dry));
            // An earlier arm takes the record unless Rust checks its guard and the guard is false.
            if (verdict !== false || !rustExpr(t.data.guard as ExprData, dry)) return false;
        }
        return false;
    });
    if (!from) return undefined;
    let actor: string | undefined;
    if (acting) {
        // The first declared actor the simulator proves the policies let run the action, created as Actor::<actor>() makes it.
        const record = { ...valid.record, [fieldName]: from };
        const found = context.graph.nodes.filter(n => n.kind === 'Actor').find(a => sim.run(action.qn, record, { actor: a.qn }, inputs).allowed === 'yes');
        if (!found) return undefined;
        actor = `${accessPath(scope, 'Actor')}::${snake(accessOf(context).name(found.qn))}()`;
    }
    const left = new Set(transitions.flatMap(t => t.data.from as string[]));
    const invalid = context.children(enumNode.qn).map(c => last(c.qn)).find(state => !left.has(state) && holds({ ...valid.record, [fieldName]: state }));
    return {
        action, valid, args, actor,
        state: fieldName,
        from: literal(from),
        to: literal(transition.data.to as string),
        invalid: invalid ? literal(invalid) : undefined
    };
}

/** The create functions an action takes, as closures that store nothing. */
function storeArgs(action: GraphNode, scope: RustScope, context: MapContext): string[] {
    return storeFunctions(actionCode(action, context).creating).map(([, e, verb]) => `&mut |_: ${verb === 'create' ? '' : '&'}${qualify(e, scope)}| Ok(())`);
}

const coverage = new WeakMap<Graph, Set<string>>();

/** The actions and transitions a scenario calls: the scenario tests replace their guessed tests. */
function covered(context: MapContext): Set<string> {
    let found = coverage.get(context.graph);
    if (!found) coverage.set(context.graph, found = coveredByScenarios(context.graph));
    return found;
}

/** A scenario inside `GraphNode.data`. */
interface ScenarioData {
    does?: string;
    fixtures?: { name?: string, entity: string, assignments?: Assignment[] }[];
    actor?: { persona: string, assignments?: Assignment[] };
    checks?: { $type: 'Expectation' | 'Emitted', condition?: ExprData, event?: string, assignments?: Assignment[] }[];
    fails?: boolean;
    error?: string;
    refused?: boolean;
}

interface Assignment { name: string, value: ExprData }

/** Why a scenario test cannot be generated; the scenario's test stays ignored with this as its task. */
class Unsupported extends Error {}

/** Names a given row cannot have in the test: Rust keywords and the test's own variables. */
const RESERVED = new Set([
    'as', 'async', 'await', 'box', 'break', 'const', 'continue', 'crate', 'dyn', 'else', 'enum', 'extern', 'false', 'fn', 'for', 'gen', 'if', 'impl',
    'in', 'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'self', 'static', 'struct', 'super', 'trait', 'true', 'try', 'type',
    'unsafe', 'use', 'where', 'while', 'yield', 'actor', 'outcome', 'events', 'emitted', 'fired', 'error'
]);

/**
 * A scenario becomes one test in its module's test module, `scenario_<name>`: the given rows built with `new`
 * (samples for the required fields the scenario does not give) and distinct ids, the actor, one call of the
 * action and its `then`. What
 * Rust cannot reproduce exactly as the simulator runs it leaves the test ignored, with a registry task.
 */
function scenarioSteps(scenario: GraphNode, context: MapContext): Step[] {
    const name = `scenario_${snake(last(scenario.qn))}`;
    try {
        const { code, local } = scenarioTest(scenario, name, context);
        return [testBlock(scenario.module, code, local)];
    } catch (error) {
        if (!(error instanceof Unsupported)) throw error;
        return testSteps(scenario, name, error.message);
    }
}

/**
 * The test's code, and whether it calls an action of its own module: then it names that module's declarations as
 * the module's other tests do, through `use super::*;`, otherwise it qualifies every name with its crate path.
 */
function scenarioTest(scenario: GraphNode, name: string, context: MapContext): { code: string, local: boolean } {
    const call = scenarioCall(scenario);
    const action = context.node(call.target)!;
    if (action.kind !== 'Action') throw new Unsupported(`the ${action.kind === 'UseCase' ? 'use case' : action.kind} ${last(action.qn)} has no generated function to call`);
    const fn = snake(last(action.qn));
    const sim = simulator(context);
    const result = sim.scenario(scenario.qn);
    if (!result.passed) throw new Unsupported(`the simulator does not pass it: ${result.failures.join(' ')}`);
    if (actionCode(action, context).tasks.length) throw new Unsupported(`${fn} has registry tasks of its own, so it does not do all the model says yet`);
    const data = scenario.data as ScenarioData;
    const fixtures = data.fixtures ?? [];
    const named = new Set(fixtures.flatMap(f => f.name ? [f.name] : []));
    for (const binding of named) if (RESERVED.has(binding)) throw new Unsupported(`the name ${binding} is a Rust keyword or a variable of the test`);
    const local = action.module === scenario.module;
    const scope: RustScope = { ...rustScope(scenario, context), module: local ? scenario.module : '', vars: new Map([...named].map(n => [n, 'other' as const])) };
    const lines: string[] = [];
    const rows = new Map<string, GraphNode>();

    // given: each row through `new`, with an id of its own, so records compare as the simulator compares them.
    fixtures.forEach((fixture, i) => {
        const entity = context.node(fixture.entity)!;
        const variable = fixture.name ?? `_given_${i + 1}`;
        if (fixture.name) rows.set(fixture.name, entity);
        const given = new Map((fixture.assignments ?? []).map(a => [a.name, a.value]));
        const stored = fieldsOf(entity, context).filter(f => !f.data.derived);
        for (const field of given.keys()) if (!stored.some(f => last(f.qn) === field)) throw new Unsupported(`${last(entity.qn)} stores no field ${field}`);
        const required = requiredFields(entity, context, rustScope(entity, context));
        const args = required.map(field => {
            const expr = given.get(last(field.qn));
            if (expr) return givenValue(field.data.type as TypeData, expr, scope, context);
            const sample = rustSample(last(field.qn), field.data.type as TypeData, scope, context, 0);
            if (!sample) throw new Unsupported(`there is no sample for the field ${last(field.qn)} of ${last(entity.qn)}`);
            return sample.rust;
        });
        lines.push(`let mut ${variable} = ${qualify(entity, scope)}::new(${args.join(', ')});`, `${variable}.id = ${i + 1};`);
        for (const field of stored.filter(f => !required.includes(f) && given.has(last(f.qn)))) {
            lines.push(`${variable}.${last(field.qn)} = ${givenValue(field.data.type as TypeData, given.get(last(field.qn))!, scope, context)};`);
        }
    });

    // as: the declared actor (a role stands for the first actor holding it); without one, a function that checks
    // an actor gets the first declared actor the simulator passes the scenario as.
    const acting = takesActor(action, context);
    const persona = data.actor;
    let actorQn: string | undefined;
    if (persona) {
        const node = context.node(persona.persona)!;
        actorQn = node.kind === 'Role' ? context.graph.nodes.find(n => n.kind === 'Actor' && ((n.data.roles ?? []) as string[]).includes(node.qn))?.qn : node.qn;
        if (!actorQn) throw new Unsupported(`no declared actor holds the role ${last(node.qn)}`);
    } else if (acting) {
        actorQn = actorFor(scenario, context);
        if (!actorQn) throw new Unsupported(`${fn} always checks an actor, and the simulator passes the scenario as no declared actor`);
    }
    const actorUsed = !!actorQn && (acting || JSON.stringify(data.checks ?? []).includes('"name":"actor"'));
    if (actorUsed) {
        const sets = (persona?.assignments ?? []).map(a => actorField(a, scope, context));
        lines.push(`let ${sets.length ? 'mut ' : ''}actor = ${accessPath(scope, 'Actor')}::${snake(accessOf(context).name(actorQn!))}();`, ...sets);
    }
    if (acting && !data.refused && enforced(context) && !checksTranslate(action, context)) {
        throw new Unsupported(`a policy or role condition that ${fn} checks has no Rust translation, so Rust denies what the simulator allows`);
    }

    // when: the action's function, the row first, then the inputs in order; missing optional inputs are None.
    const args = [...call.args];
    const rustArgs = acting ? ['&actor'] : [];
    let subject: string | undefined;
    if (action.data.entity) {
        const row = args.shift();
        if (row?.$type !== 'NameExpr' || !named.has(row.name!)) throw new Unsupported(`the first argument of ${fn} is not a given row`);
        subject = row.name!;
        rustArgs.push(`&mut ${subject}`);
    }
    const params = context.children(action.qn).filter(c => c.kind === 'Param');
    const inputs: string[] = params.map((param, i) => {
        const type = param.data.type as TypeData;
        const expr = args[i];
        if (expr) return givenValue(type, expr, scope, context);
        if (type.many) return 'Vec::new()';
        if (type.optional) return 'None';
        throw new Unsupported(`the scenario gives no value for the input ${last(param.qn)} of ${fn}`);
    });
    if (subject && inputs.some(i => new RegExp(`\\b${subject}\\b`).test(i))) throw new Unsupported(`an input of ${fn} reads ${subject}, which the call borrows mutably`);
    rustArgs.push(...inputs, ...storeArgs(action, scope, context));
    const path = local ? '' : `crate::${action.module.replaceAll('.', '::')}::`;
    lines.push(`let outcome = ${path || (named.has(fn) ? 'super::' : '')}${fn}(${rustArgs.join(', ')});`);

    // then
    if (data.refused) {
        if (!guardOf(action, context)) throw new Unsupported(`${fn} checks no policy before it runs`);
        lines.push(`assert!(matches!(outcome, Err(${path}Error::Forbidden { .. })), ${rustMessage(`${fn} refuses the actor`, ': {outcome:?}')});`);
    } else if (data.fails) {
        failsFirst(action, call.args, data, result.rows, persona, actorQn, context);
        lines.push(data.error
            ? `assert!(matches!(outcome, Err(${path}Error::${last(data.error)})), ${rustMessage(`${fn} fails with ${last(data.error)}`, ': {outcome:?}')});`
            : `assert!(matches!(outcome, Err(ref error) if !matches!(error, ${path}Error::Forbidden { .. })), ${rustMessage(`${fn} fails`, ': {outcome:?}')});`);
    } else {
        const checks = data.checks ?? [];
        const shown = (scenario.props.checks ?? []) as string[];
        const asserts = checks.map((check, i) => {
            if (check.$type === 'Expectation') return `assert!(${expectation(check.condition!, subject ? { name: subject, entity: rows.get(subject)! } : undefined, actorUsed, scope, context)}, ${rustMessage(shown[i])});`;
            return `assert!(events.iter().any(|emitted| ${emittedPattern(check.event!, check.assignments ?? [], action, path, scope, context)}), ${rustMessage(`${fn} emits ${shown[i].replace(/^emitted /, '')}`, ': {events:?}')});`;
        });
        lines.push(`${checks.some(c => c.$type === 'Emitted') ? 'let events = ' : ''}outcome.expect(${rustMessage(`${fn} runs`)});`, ...asserts);
    }

    // A row nothing reads is named with `_`, so the test compiles without warnings.
    const body = [...lines];
    for (const binding of named) {
        const declared = new RegExp(`^(let mut |)${binding}\\b`);
        const reads = body.filter(l => !declared.test(l) && new RegExp(`\\b${binding}\\b`).test(l));
        if (!reads.length) body.forEach((l, i) => { if (declared.test(l)) body[i] = l.replace(new RegExp(`\\b${binding}\\b`), `_${binding}`); });
    }
    const doc = data.does ? `/// ${data.does}` : `/// The scenario ${scenario.qn}.`;
    return { code: [doc, '#[test]', `fn ${name}() {`, ...body.map(l => `    ${l}`), '}'].join('\n'), local };
}

/**
 * The pattern an emitted event matches: its variant of the action module's `Event`, and the given field values,
 * records by id (the event holds a clone from when it was emitted, the simulator compares rows by identity).
 */
function emittedPattern(eventQn: string, assignments: Assignment[], action: GraphNode, path: string, scope: RustScope, context: MapContext): string {
    const event = context.node(eventQn)!;
    if (event.module !== action.module) throw new Unsupported(`${last(event.qn)} is not an event of the module of ${last(action.qn)}`);
    const variant = `${path}Event::${last(event.qn)}`;
    if (!assignments.length) return `matches!(emitted, ${variant}(_))`;
    const conditions = assignments.map(({ name, value }) => {
        const field = fieldsOf(event, context).find(f => last(f.qn) === name);
        const type = field?.data.type as TypeData | undefined;
        if (!field || !type || type.many) throw new Unsupported(`Rust cannot compare the field ${name} of ${last(event.qn)}`);
        if (type.decl && context.node(type.decl)?.kind === 'Entity') {
            if (value.$type === 'NullExpr') return `fired.${name}.is_none()`;
            const term = rustTerm(value, scope);
            if (!term || term.option || term.null) throw new Unsupported(`the value of ${name} in emitted ${last(event.qn)} is not a given row`);
            return type.optional ? `fired.${name}.as_ref().map(|r| r.id) == Some(${term.value}.id)` : `fired.${name}.id == ${term.value}.id`;
        }
        const expected = assigned(field, value, scope);
        if (!expected) throw new Unsupported(`Rust cannot say the value of ${name} in emitted ${last(event.qn)}`);
        return `fired.${name} == ${expected}`;
    });
    return `matches!(emitted, ${variant}(fired) if ${conditions.join(' && ')})`;
}

/** A string literal for an assertion message: braces doubled, then the format arguments. */
function rustMessage(text: string, args = ''): string {
    return JSON.stringify(text.replace(/\{/g, '{{').replace(/\}/g, '}}') + args);
}

/** A field type as the pseudo field `assigned` reads. */
function typed(type: TypeData): GraphNode {
    return { qn: '', kind: 'Field', data: { type } } as unknown as GraphNode;
}

/**
 * A value the scenario gives to a field or an input: a record is a clone of the given row in a `Box`, a list of
 * records holds clones, other values as effects assign them.
 */
function givenValue(type: TypeData, expr: ExprData, scope: RustScope, context: MapContext): string {
    const entity = !!type.decl && context.node(type.decl)?.kind === 'Entity';
    const record = (e: ExprData) => {
        const term = rustTerm(e, scope);
        if (!term || term.option || term.null) throw new Unsupported(`the record ${JSON.stringify(e.name ?? e.member ?? e.$type)} is not a given row Rust can clone`);
        return `${term.value}.clone()`;
    };
    if (type.many && expr.$type === 'ListExpr') {
        const items = (expr.items ?? []).map(item => entity ? record(item) : givenValue({ ...type, many: false, optional: false }, item, scope, context));
        return items.length ? `vec![${items.join(', ')}]` : 'Vec::new()';
    }
    if (entity && !type.many) {
        if (expr.$type === 'NullExpr' && type.optional) return 'None';
        return type.optional ? `Some(Box::new(${record(expr)}))` : `Box::new(${record(expr)})`;
    }
    const value = assigned(typed(type), expr, scope);
    if (!value) throw new Unsupported(`Rust cannot say the value of type ${type.primitive ?? type.decl} it gives`);
    return value;
}

/** A field value of the actor: records by id, everything else in `Some`. */
function actorField(assignment: Assignment, scope: RustScope, context: MapContext): string {
    const field = actorFields(context).find(f => last(f.qn) === assignment.name);
    const type = field?.data.type as TypeData | undefined;
    if (!field || !type || !actorFieldType(field, context) || type.many) throw new Unsupported(`the Actor has no field ${assignment.name} that Rust can set`);
    if (assignment.value.$type === 'NullExpr') return `actor.${assignment.name} = None;`;
    if (type.decl) {
        const term = rustTerm(assignment.value, scope);
        if (!term || term.option) throw new Unsupported(`the actor field ${assignment.name} is not a given row`);
        return `actor.${assignment.name} = Some(${term.value}.id);`;
    }
    const value = assigned(typed({ ...type, optional: true }), assignment.value, scope);
    if (!value) throw new Unsupported(`Rust cannot say the value of the actor field ${assignment.name}`);
    return `actor.${assignment.name} = ${value};`;
}

/** The first declared actor the simulator passes the scenario as, for a call without `as` to a function that checks an actor. */
function actorFor(scenario: GraphNode, context: MapContext): string | undefined {
    return context.graph.nodes.filter(n => n.kind === 'Actor').find(actor => {
        const nodes = context.graph.nodes.map(n => n === scenario ? { ...n, data: { ...n.data, actor: { $type: 'ScenarioActor', persona: actor.qn } } } : n);
        return new Simulator({ ...context.graph, nodes }).scenario(scenario.qn).passed;
    })?.qn;
}

/**
 * For a call that should fail: the policies must allow it (else Rust returns `Forbidden`), and the first
 * precondition that does not hold, the one Rust returns, must be proven false and carry the expected error.
 */
function failsFirst(action: GraphNode, args: ExprData[], data: ScenarioData, rows: { [name: string]: SimRecord }, persona: ScenarioData['actor'], actorQn: string | undefined, context: MapContext): void {
    const sim = simulator(context);
    const vars = new Map<string, Value>(Object.entries(rows));
    const actor: SimActor | undefined = actorQn ? { actor: actorQn, fields: Object.fromEntries((persona?.assignments ?? []).map(a => [a.name, sim.evaluate(a.value, { vars })])) } : undefined;
    const values = args.map(a => sim.evaluate(a, { actor, vars }));
    const self = action.data.entity ? values.shift() as SimRecord : {};
    const inputs = Object.fromEntries(context.children(action.qn).filter(c => c.kind === 'Param').map((p, i) => [last(p.qn), values[i] ?? null]));
    if (actor && enforced(context) && sim.run(action.qn, self, actor, inputs).allowed !== 'yes') throw new Unsupported(`the simulator cannot prove that the policies let the actor call ${last(action.qn)}`);
    if (!data.error) return;
    for (const precondition of (action.data.preconditions ?? []) as { condition: ExprData, error?: string }[]) {
        const holds = sim.evaluate(precondition.condition, { self, actor, inputs });
        if (holds === true) continue;
        if (holds === false && precondition.error === data.error) return;
        break;
    }
    throw new Unsupported(`the simulator cannot prove that ${last(data.error)} is the first error ${last(action.qn)} returns`);
}

/**
 * A `then` expression in Rust, over the rows as local variables. A comparison of records (a `Box` against a row)
 * and a read of the called row through another record (a clone from before the call) are left to a task.
 */
function expectation(condition: ExprData, subject: { name: string, entity: GraphNode } | undefined, actor: boolean, scope: RustScope, context: MapContext): string {
    const entities = new Set(context.graph.nodes.filter(n => n.kind === 'Entity').map(n => last(n.qn)));
    const base = (e?: ExprData) => e?.type?.replace(/\?$/, '').replace(/\[\]$/, '') ?? '';
    const actorRooted = (e?: ExprData): boolean => !!e && (e.$type === 'NameExpr' ? e.name === 'actor' || (!!e.target && context.node(e.target)?.kind === 'Tenant') : actorRooted(e.receiver));
    const walk = (e: unknown): void => {
        if (Array.isArray(e)) { e.forEach(walk); return; }
        if (!e || typeof e !== 'object') return;
        const node = e as ExprData;
        if (node.$type === 'BinaryExpr' && ['==', '!=', 'in'].includes(node.op!)) {
            const sides = [node.left, node.op === 'in' ? node.right?.items?.[0] : node.right];
            if (sides.some(s => entities.has(base(s))) && !sides.some(actorRooted)) throw new Unsupported('a check compares records, which Rust holds as clones');
        }
        if (node.$type === 'MemberExpr' && subject && node.receiver && !(node.receiver.$type === 'NameExpr' && scope.vars?.has(node.receiver.name!))) {
            if (base(node.receiver) === last(subject.entity.qn)) throw new Unsupported(`a check reads ${subject.name} through another record, which holds a clone from before the call`);
        }
        for (const value of Object.values(node)) walk(value);
    };
    walk(condition);
    const code = rustExpr(condition, { ...scope, actor: actor ? '(&actor)' : undefined });
    if (!code) throw new Unsupported('Rust cannot say one of its checks');
    // Reading an optional field must not move it out of the row, which later checks read again.
    return code.replace(/\b([a-z_]\w*(?:\.[a-z_]\w*)+)\.unwrap\(\)/g, '$1.clone().unwrap()');
}

/**
 * The test helper `valid_<entity>` in the module's test module: `<Entity>::new` with a sample for every argument,
 * and the record the simulator sees. Undefined when an argument has no sample or an invariant `validate` checks
 * is not proven to hold.
 */
function validRecord(entity: GraphNode, scope: RustScope, context: MapContext): { name: string, record: SimRecord, step: Step } | undefined {
    const built = construct(entity, scope, context, 0);
    if (!built) return undefined;
    const checked = context.children(entity.qn).filter(n => n.kind === 'Invariant' && validation(n, context));
    if (!checked.every(i => simulator(context).evaluate(i.data.condition as ExprData, { self: built.value }) === true)) return undefined;
    const name = `valid_${snake(last(entity.qn))}`;
    const code = [
        `/// ${/^[AEIOU]/.test(last(entity.qn)) ? 'An' : 'A'} ${last(entity.qn)} with the defaults of the model and a sample for every other required field.`,
        `fn ${name}() -> ${last(entity.qn)} {`, `    ${built.rust}`, '}', ''
    ].join('\n');
    const block = testBlock(entity.module, code) as Extract<Step, { kind: 'template' }>;
    return { name, record: built.value, step: { ...block, write: existing => existing?.includes(`\n    fn ${name}() `) ? existing : block.write(existing) } };
}

/** `<Entity>::new(...)` with samples for its arguments, and the record the simulator sees. */
function construct(entity: GraphNode, scope: RustScope, context: MapContext, depth: number): { rust: string, value: SimRecord } | undefined {
    if (depth > 3) return undefined;
    const required = requiredFields(entity, context, scope);
    const value: SimRecord = { $type: entity.qn };
    const args: string[] = [];
    for (const field of fieldsOf(entity, context).filter(f => !f.data.derived)) {
        const type = field.data.type as TypeData;
        if (required.includes(field)) {
            const sample = rustSample(last(field.qn), type, scope, context, depth);
            if (!sample) return undefined;
            args.push(sample.rust);
            value[last(field.qn)] = sample.value;
        } else if (type.many) value[last(field.qn)] = [];
        else if (field.data.default) value[last(field.qn)] = simulator(context).evaluate(field.data.default as ExprData, { self: value });
        else value[last(field.qn)] = null;
    }
    return { rust: `${qualify(entity, scope)}::new(${args.join(', ')})`, value };
}

/** A sample of a required value in Rust and as the simulator sees it: entities through their `new`, value types field by field. */
function rustSample(name: string, type: TypeData, scope: RustScope, context: MapContext, depth: number): { rust: string, value: Value } | undefined {
    if (type.many) return { rust: 'Vec::new()', value: [] };
    if (type.optional) return { rust: 'None', value: null };
    if (type.decl) {
        const decl = context.node(type.decl);
        if (decl?.kind === 'Enum') {
            const first = context.children(decl.qn)[0];
            return first && { rust: enumVariant(first, scope), value: last(first.qn) };
        }
        if (decl?.kind === 'Entity') {
            const built = construct(decl, scope, context, depth + 1);
            return built && { rust: `Box::new(${built.rust})`, value: built.value };
        }
        if (decl?.kind === 'ValueType') {
            const value: SimRecord = { $type: decl.qn };
            const fields: string[] = [];
            for (const field of fieldsOf(decl, context).filter(f => !f.data.derived)) {
                const sample = rustSample(last(field.qn), field.data.type as TypeData, scope, context, depth + 1);
                if (!sample) return undefined;
                fields.push(`${last(field.qn)}: ${sample.rust}`);
                value[last(field.qn)] = sample.value;
            }
            return { rust: `${qualify(decl, scope)} { ${fields.join(', ')} }`, value };
        }
        return undefined;
    }
    switch (type.primitive) {
        case 'String':
        case 'Text':
        case 'File': return { rust: `${JSON.stringify(`${name}-1`)}.to_string()`, value: `${name}-1` };
        case 'Uuid': return { rust: '"00000000-0000-4000-8000-000000000001".to_string()', value: '00000000-0000-4000-8000-000000000001' };
        case 'Int': return { rust: '1', value: 1 };
        case 'Decimal':
        case 'Money': return { rust: 'rust_decimal::Decimal::from(1)', value: 1 };
        case 'Bool': return { rust: 'false', value: false };
        case 'Date': return { rust: 'chrono::NaiveDate::from_ymd_opt(2026, 1, 1).unwrap()', value: UNKNOWN };
        case 'DateTime': return { rust: 'chrono::Utc::now()', value: UNKNOWN };
        case 'Duration': return { rust: 'chrono::TimeDelta::hours(1)', value: 3_600_000 };
    }
    return undefined;
}

/** An assignment such as `x.discount = -1;` that makes the invariant false on the valid record, trying the fields the condition reads in order. */
function violating(invariant: GraphNode, entity: GraphNode, record: SimRecord, scope: RustScope, context: MapContext): string | undefined {
    const condition = invariant.data.condition as ExprData;
    const read = targets(condition);
    for (const field of fieldsOf(entity, context).filter(f => read.has(f.qn) && !f.data.derived && !(f.data.type as TypeData).many)) {
        for (const candidate of candidates(field.data.type as TypeData, scope, context)) {
            if (simulator(context).evaluate(condition, { self: { ...record, [last(field.qn)]: candidate.value } }) !== false) continue;
            return `x.${last(field.qn)} = ${candidate.rust};`;
        }
    }
    return undefined;
}

/** The values tried on a field: a few numbers, both booleans, the empty string, every enum literal, and `None` when optional. */
function candidates(type: TypeData, scope: RustScope, context: MapContext): { rust: string, value: Value }[] {
    const found: { rust: string, value: Value }[] = [];
    if (type.decl) {
        const decl = context.node(type.decl);
        if (decl?.kind === 'Enum') for (const literal of context.children(decl.qn)) found.push({ rust: enumVariant(literal, scope), value: last(literal.qn) });
    } else {
        const numbers = [-1, 0, 1_000_000];
        switch (type.primitive) {
            case 'Int': found.push(...numbers.map(n => ({ rust: String(n), value: n }))); break;
            case 'Decimal':
            case 'Money': found.push(...numbers.map(n => ({ rust: `rust_decimal::Decimal::from(${n})`, value: n }))); break;
            case 'Bool': found.push(...[true, false].map(b => ({ rust: String(b), value: b }))); break;
            case 'String':
            case 'Text': found.push({ rust: 'String::new()', value: '' }); break;
        }
    }
    if (!type.optional) return found;
    return [{ rust: 'None', value: null }, ...found.map(c => ({ ...c, rust: `Some(${c.rust})` }))];
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

function defaultValue(field: GraphNode, scope: RustScope): string | undefined {
    const expr = field.data.default as ExprData | undefined;
    const code = expr && rustExpr(expr, scope);
    if (!code) return undefined;
    return (field.data.type as TypeData).optional ? `Some(${coerce(code, field)})` : coerce(code, field);
}

/** Number literals assigned to decimal fields become decimals, string literals assigned to text fields owned `String`s. */
function coerce(code: string, field: GraphNode): string {
    const type = field.data.type as TypeData;
    if (!type.many && ['String', 'Text', 'File', 'Uuid'].includes(type.primitive ?? '') && /^"([^"\\]|\\.)*"$/.test(code)) return `${code}.to_string()`;
    if (!(type.primitive === 'Money' || type.primitive === 'Decimal') || !/^-?[\d.]+$/.test(code)) return code;
    return code.includes('.') ? `rust_decimal::Decimal::from_str_exact(${JSON.stringify(code)}).unwrap()` : `rust_decimal::Decimal::from(${code})`;
}

function typeOf(type: TypeData, scope: RustScope): string {
    let base = 'String';
    if (type.primitive) base = PRIMITIVES[type.primitive];
    else if (type.decl) {
        const declaration = scope.node(type.decl)!;
        base = declaration.kind === 'Entity' ? `Box<${qualify(declaration, scope)}>` : qualify(declaration, scope);
    }
    if (type.many) return `Vec<${base.replace(/^Box<(.*)>$/, '$1')}>`;
    return type.optional ? `Option<${base}>` : base;
}

/** Inserts a block before the test module of a module's file. */
function append(module: string, block: string): Step {
    return rustFile(module, text => text.replace('#[cfg(test)]\nmod tests {', `${block}\n\n#[cfg(test)]\nmod tests {`));
}

function rustFile(module: string, write: (text: string) => string): Step {
    return { kind: 'template', file: `src/${module.replaceAll('.', '/')}.rs`, write: existing => write(existing ?? '') };
}

function rustScope(node: GraphNode, context: MapContext): RustScope {
    return { node: context.node, module: node.module || node.qn, access: accessOf(context) };
}

function fieldsOf(node: GraphNode, context: MapContext): GraphNode[] {
    return context.children(node.qn).filter(c => c.kind === 'Field');
}

function crate(context: MapContext): string {
    return context.name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
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

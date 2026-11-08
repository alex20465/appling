import type { CodegenExtension, MapContext, Step } from '@appling/codegen';
import type { ExprData, GraphNode, TypeData } from '@appling/model';
import { accessFile, accessOf, accessSteps, actorFieldType, durationAttribute, durationSteps, libStep, PRIMITIVES, tenantOf, tenantPaths } from './access.js';
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
            case 'Invariant': return [...(validation(node, context) ? [] : [task(`check the invariant "${node.data.label}" in validate: ${node.props.condition}`)]), ...testSteps(node)];
            case 'Policy': return [...policySteps(node, context), ...testSteps(node)];
            case 'Role':
            case 'Actor':
            case 'Tenant':
                return accessSteps(node, context);
            case 'Action': return actionSteps(node, context);
            case 'Machine': return machineSteps(node, context);
            case 'Transition': return testSteps(node);
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
                return [...guardSteps(node, context), task(`implement the ${node.kind.toLowerCase()} ${last(node.qn)} on top of the generated domain module, with the storage, HTTP and scheduling crates of your choice`)];
            case 'Job':
            case 'Projection':
            case 'External':
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

/** An action becomes a function on `&mut` its entity: preconditions, the state transition, effects, and the emitted events. */
function actionSteps(action: GraphNode, context: MapContext): Step[] {
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
    const creating: Creating = { action: last(action.qn), entities: new Map() };
    if (transitions.length && self) body.push(...transitionMatch(transitions, self, last(action.qn), scope, context, tasks, creating));
    for (const effect of context.children(action.qn).filter(c => c.kind.endsWith('Effect'))) body.push(...effectLines(effect, self, scope, context, tasks, creating));
    const emits = body.some(l => l.includes('events.push('));
    const params = context.children(action.qn).filter(c => c.kind === 'Param').map(p => {
        const used = body.some(l => new RegExp(`\\b${last(p.qn)}\\b`).test(l));
        return `${used ? '' : '_'}${last(p.qn)}: ${typeOf(p.data.type as TypeData, scope)}`;
    });
    const actor = guard || enforced(context) ? [`${body.some(l => /\bactor\b/.test(l)) ? '' : '_'}actor: &${accessPath(scope, 'Actor')}`] : [];
    const stores = [...creating.entities.values()].map(e => `create_${snake(last(e.qn))}: &mut dyn FnMut(${qualify(e, scope)}) -> Result<(), Error>`);
    const code = [
        `/// The action ${action.qn}. It returns the events it emits.${stores.length ? ' The records it creates go to the create functions, which store them.' : ''}`,
        `pub fn ${snake(last(action.qn))}(${[...actor, ...(entity ? [`${self}: &mut ${qualify(entity, scope)}`] : []), ...params, ...stores].join(', ')}) -> Result<Vec<Event>, Error> {`,
        `    let ${emits ? 'mut ' : ''}events = Vec::new();`,
        ...body.map(l => `    ${l}`),
        '    Ok(events)',
        '}'
    ].join('\n');
    return [append(action.module, code), ...guardSteps(action, context), ...tasks, ...testSteps(action)];
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
    const params = owner.kind === 'Action' || owner.kind === 'UseCase' ? context.children(owner.qn).filter(c => c.kind === 'Param') : [];
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
        for (const effect of context.children(transition.qn)) lines.push(...effectLines(effect, self, scope, context, tasks, creating).map(l => `        ${l}`));
        lines.push(`        ${state} = ${enumVariant(context.node(`${enumNode.qn}.${transition.data.to}`)!, scope)};`, '    }');
    }
    lines.push(`    _ => return Err(Error::InvalidTransition { action: ${JSON.stringify(label)}, from: format!("{:?}", ${state}) }),`, '}');
    return lines;
}

/** The records an action creates: each created entity becomes a `create_<entity>` function parameter that stores one. */
interface Creating {
    action: string;
    entities: Map<string, GraphNode>;
}

function effectLines(effect: GraphNode, self: string | undefined, scope: RustScope, context: MapContext, tasks: Step[], creating?: Creating): string[] {
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
    const sets: string[] = [];
    for (const field of fieldsOf(entity, context).filter(f => !f.data.derived && !required.includes(f))) {
        const expr = given.get(last(field.qn));
        if (!expr) continue;
        const value = assigned(field, expr, scope);
        if (!value) return undefined;
        sets.push(`created.${last(field.qn)} = ${value};`);
    }
    const check = enforced(context) ? [
        `if !${entity.module === effect.module ? '' : `crate::${entity.module.replaceAll('.', '::')}::`}can_create_${snake(last(entity.qn))}(actor, &created) {`,
        `    return Err(Error::Forbidden { action: ${JSON.stringify(creating.action)} });`,
        '}'
    ] : [];
    creating.entities.set(entity.qn, entity);
    return ['{', ...[`let ${sets.length ? 'mut ' : ''}created = ${qualify(entity, scope)}::new(${args.join(', ')});`, ...sets, ...check, `create_${snake(last(entity.qn))}(created)?;`].map(l => `    ${l}`), '}'];
}

/** Whether an effect runs in an action, which takes the actor, rather than in a transition on an event. */
function runByActor(effect: GraphNode, context: MapContext): boolean {
    const owner = context.node(effect.qn.slice(0, effect.qn.lastIndexOf('.effect[')));
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
    return steps;
}

/** An ignored test per rule in the module's test module; writing its body is a registry task. */
function testSteps(node: GraphNode): Step[] {
    const name = snake(`${last(parentOf(node.qn))}_${String(node.data.label ?? last(node.qn))}`).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    return [
        rustFile(node.module, text => text.replace(/(#\[cfg\(test\)\]\nmod tests \{\n)([\s\S]*?)(\}\n?$)/, (_, head, body, end) => `${head}${body}    #[test]\n    #[ignore = ${JSON.stringify(`registry task: ${node.qn}`)}]\n    fn ${name}() {}\n${end}`)),
        task(`write the test ${name}`)
    ];
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

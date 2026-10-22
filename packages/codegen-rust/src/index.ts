import type { CodegenExtension, MapContext, Step } from '@appling/codegen';
import type { ExprData, GraphNode, TypeData } from '@appling/model';
import { enumVariant, pascal, qualify, rustExpr, snake, type RustScope } from './rust.js';

const PRIMITIVES: { [name: string]: string } = {
    String: 'String', Text: 'String', Int: 'i64', Bool: 'bool', File: 'String', Uuid: 'String',
    Decimal: 'rust_decimal::Decimal', Money: 'rust_decimal::Decimal',
    Date: 'chrono::NaiveDate', DateTime: 'chrono::DateTime<chrono::Utc>', Duration: 'chrono::TimeDelta'
};

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
            case 'ValueType': return [append(node.module, structBlock(node, context, `The value type ${node.qn}.`))];
            case 'Event': return [
                append(node.module, structBlock(node, context, `The event ${node.qn}.`)),
                rustFile(node.module, text => text.replace(/(pub enum Event \{[\s\S]*?)(\n\})/, (_, head, end) => `${head}\n    ${last(node.qn)}(${last(node.qn)}),${end}`))
            ];
            case 'ErrorDecl': return [rustFile(node.module, text => text.includes(`    ${last(node.qn)},\n`) ? text : text.replace(/(pub enum Error \{[\s\S]*?)(\n\})/, (_, head, end) => `${head}\n    ${last(node.qn)},${end}`))];
            case 'Entity': return [append(node.module, entityBlock(node, context))];
            case 'Field': return fieldSteps(node, context);
            case 'Invariant': return [...(validation(node, context) ? [] : [task(`check the invariant "${node.data.label}" in validate: ${node.props.condition}`)]), ...testSteps(node)];
            case 'Policy': return [task(`enforce the policy ${node.qn}: ${node.props.condition}`), ...testSteps(node)];
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
            case 'Job':
            case 'Query':
            case 'Projection':
            case 'External':
            case 'UseCase':
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
        { kind: 'template', file: parent, write: existing => !existing || existing.includes('pub fn add(') ? `//! The ${crate(context)} model, generated by Appling.\n\n${declare}\n` : existing.includes(declare) ? existing : `${existing.trimEnd()}\n${declare}\n` },
        rustFile(module.qn, existing => existing || start)
    ];
}

function enumBlock(node: GraphNode, context: MapContext): string {
    const variants = context.children(node.qn).flatMap(l => [`    #[serde(rename = ${JSON.stringify(last(l.qn))})]`, `    ${pascal(last(l.qn))},`]);
    return [`/// The enum ${node.qn}.`, '#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]', `pub enum ${last(node.qn)} {`, ...variants, '}'].join('\n');
}

function structBlock(node: GraphNode, context: MapContext, doc: string): string {
    const scope = rustScope(node, context);
    const fields = fieldsOf(node, context).filter(f => !f.data.derived).map(f => `    pub ${last(f.qn)}: ${typeOf(f.data.type as TypeData, scope)},`);
    return [`/// ${doc}`, DERIVE, `pub struct ${last(node.qn)} {`, ...fields, '}'].join('\n');
}

/** An entity becomes a struct with an id, `new` taking the fields without default, methods for derived fields, and `validate`. */
function entityBlock(entity: GraphNode, context: MapContext): string {
    const name = last(entity.qn);
    const scope = rustScope(entity, context);
    const fields = fieldsOf(entity, context);
    const stored = fields.filter(f => !f.data.derived);
    const required = stored.filter(f => {
        const type = f.data.type as TypeData;
        return !type.optional && !type.many && !defaultValue(f, scope);
    });
    const lines = [`/// The entity ${entity.qn}.`, DERIVE, `pub struct ${name} {`, '    pub id: i64,', ...stored.map(f => `    pub ${last(f.qn)}: ${typeOf(f.data.type as TypeData, scope)},`), '}', '', `impl ${name} {`];
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
    return lines.join('\n');
}

function fieldSteps(field: GraphNode, context: MapContext): Step[] | undefined {
    const owner = context.node(parentOf(field.qn))!;
    if (owner.kind === 'Event' || owner.kind === 'ValueType') return [];
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
    ((action.data.preconditions ?? []) as { condition: ExprData, error?: string }[]).forEach((precondition, i) => {
        const condition = rustExpr(precondition.condition, scope);
        if (!condition || !precondition.error) {
            tasks.push(task(`check the precondition ${(action.props.preconditions as string[])[i]} in ${last(action.qn)}`));
            return;
        }
        body.push(`if !(${condition}) {`, `    return Err(Error::${last(precondition.error)});`, '}');
    });
    const transitions = context.graph.nodes.filter(n => n.kind === 'Transition' && n.data.action === action.qn);
    if (transitions.length && self) body.push(...transitionMatch(transitions, self, last(action.qn), scope, context, tasks));
    for (const effect of context.children(action.qn).filter(c => c.kind.endsWith('Effect'))) body.push(...effectLines(effect, self, scope, context, tasks));
    const emits = body.some(l => l.includes('events.push('));
    const params = context.children(action.qn).filter(c => c.kind === 'Param').map(p => {
        const used = body.some(l => new RegExp(`\\b${last(p.qn)}\\b`).test(l));
        return `${used ? '' : '_'}${last(p.qn)}: ${typeOf(p.data.type as TypeData, scope)}`;
    });
    const code = [
        `/// The action ${action.qn}. It returns the events it emits.`,
        `pub fn ${snake(last(action.qn))}(${[...(entity ? [`${self}: &mut ${last(entity.qn)}`] : []), ...params].join(', ')}) -> Result<Vec<Event>, Error> {`,
        `    let ${emits ? 'mut ' : ''}events = Vec::new();`,
        ...body.map(l => `    ${l}`),
        '    Ok(events)',
        '}'
    ].join('\n');
    return [append(action.module, code), ...tasks, ...testSteps(action)];
}

function transitionMatch(transitions: GraphNode[], self: string, label: string, scope: RustScope, context: MapContext, tasks: Step[]): string[] {
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
        for (const effect of context.children(transition.qn)) lines.push(...effectLines(effect, self, scope, context, tasks).map(l => `        ${l}`));
        lines.push(`        ${state} = ${enumVariant(context.node(`${enumNode.qn}.${transition.data.to}`)!, scope)};`, '    }');
    }
    lines.push(`    _ => return Err(Error::InvalidTransition { action: ${JSON.stringify(label)}, from: format!("{:?}", ${state}) }),`, '}');
    return lines;
}

function effectLines(effect: GraphNode, self: string | undefined, scope: RustScope, context: MapContext, tasks: Step[]): string[] {
    if (effect.kind === 'SetEffect') {
        const field = context.node(effect.data.field as string)!;
        const value = rustExpr(effect.data.value as ExprData, scope);
        if (!value || !self) {
            tasks.push(task(`apply the effect set ${last(field.qn)} = ${effect.props.value}`));
            return [];
        }
        const code = coerce(value, field);
        return [`${self}.${last(field.qn)} = ${(field.data.type as TypeData).optional ? `Some(${code})` : code};`];
    }
    if (effect.kind === 'EmitEffect') {
        const event = context.node(effect.data.event as string)!;
        const fields = new Map(fieldsOf(event, context).map(f => [last(f.qn), f]));
        const assignments = ((effect.data.assignments ?? []) as { name: string, value: ExprData }[]).map(a => {
            const value = rustExpr(a.value, scope);
            const field = fields.get(a.name);
            const entity = field && context.node((field.data.type as TypeData).decl ?? '')?.kind === 'Entity';
            return [a.name, value && (entity ? `Box::new(${value}.clone())` : value)];
        });
        if (assignments.some(([, v]) => !v)) {
            tasks.push(task(`emit ${last(event.qn)}`));
            return [];
        }
        const path = event.module === scope.module ? 'Event' : `crate::${event.module.replaceAll('.', '::')}::Event`;
        return [`events.push(${path}::${last(event.qn)}(${qualify(event, scope)} { ${assignments.map(([n, v]) => `${n}: ${v}`).join(', ')} }));`];
    }
    tasks.push(task(`apply the effect ${last(effect.qn)}, for example through your storage layer`));
    return [];
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

/** Number literals assigned to decimal fields become decimals. */
function coerce(code: string, field: GraphNode): string {
    const type = field.data.type as TypeData;
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
    return { node: context.node, module: node.module || node.qn };
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

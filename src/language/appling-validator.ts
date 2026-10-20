import { AstUtils, type AstNode, type ValidationAcceptor, type ValidationChecks } from 'langium';
import {
    isAction, isEntity, isEnum, isMachine, isModule, isValueType,
    type ApplingAstType, type Endpoint, type Machine, type Migration, type Model, type Module, type Policy,
    type Projection, type SetEffect
} from './generated/ast.js';
import { projectionSourceEntity } from './appling-scope.js';
import { hasStableId } from './appling-printer.js';
import type { ApplingServices } from './appling-module.js';

type Layer = 'cross' | 'domain' | 'behavior' | 'application' | 'interface' | 'experience';

const LAYER_OF: Record<string, Layer> = {
    Module: 'cross', Role: 'cross', Actor: 'cross', Tenant: 'cross', Migration: 'cross',
    Enum: 'domain', ValueType: 'domain', Entity: 'domain',
    Event: 'behavior', Action: 'behavior', Machine: 'behavior', Job: 'behavior',
    Query: 'application', Projection: 'application', External: 'application', UseCase: 'application',
    Interface: 'interface',
    Page: 'experience', Navigation: 'experience', Flow: 'experience', Messages: 'experience'
};

export function registerValidationChecks(services: ApplingServices): void {
    const validator = new ApplingValidator(services);
    const checks: ValidationChecks<ApplingAstType> = {
        Model: [validator.checkStableIds, validator.checkLayerReferences],
        Module: validator.checkExports,
        Machine: validator.checkMachine,
        SetEffect: validator.checkSetEffect,
        Policy: validator.checkPolicyScope,
        Projection: validator.checkProjectionFields,
        Endpoint: validator.checkEndpointShape,
        Migration: validator.checkMigration
    };
    services.validation.ValidationRegistry.register(checks, validator);
}

export class ApplingValidator {

    constructor(private readonly services: ApplingServices) { }

    checkStableIds(model: Model, accept: ValidationAcceptor): void {
        const owners = this.allStableIds();
        for (const node of AstUtils.streamAst(model).filter(hasStableId)) {
            const id = (node as AstNode & { id?: string }).id;
            if (!id) {
                accept('error', `${node.$type} has no stable id. Run "appling fmt" to assign one.`, { node });
            } else if ((owners.get(id) ?? 0) > 1) {
                accept('error', `Stable id ${id} is used more than once.`, { node, property: 'id' });
            }
        }
    }

    checkLayerReferences(model: Model, accept: ValidationAcceptor): void {
        for (const node of AstUtils.streamAst(model)) {
            for (const ref of AstUtils.streamReferences(node)) {
                const target = AstUtils.getReferenceNodes(ref.reference)[0];
                const from = memberOf(node);
                const to = target && memberOf(target);
                if (!from || !to || isAllowed(from, to)) continue;
                accept('error',
                    `${LAYER_OF[from.$type]} element ${from.$type} may not reference ${LAYER_OF[to.$type]} element ${to.$type} "${ref.reference.$refText}".`,
                    { node, property: ref.property, index: ref.index });
            }
        }
    }

    checkExports(module: Module, accept: ValidationAcceptor): void {
        const names = new Set(module.members.map(m => 'name' in m ? m.name : undefined));
        for (const exp of module.exports) {
            exp.names.forEach((name, index) => {
                if (!names.has(name)) accept('error', `Module ${module.name} has no member "${name}" to export.`, { node: exp, property: 'names', index });
            });
        }
    }

    checkMachine(machine: Machine, accept: ValidationAcceptor): void {
        const field = machine.field.ref;
        if (!field) return;
        const enumDecl = field.type.decl?.ref;
        if (!isEntity(field.$container) || !field.modifiers.includes('state') || !isEnum(enumDecl)) {
            accept('error', 'A machine must govern an entity field marked "state" with an enum type.', { node: machine, property: 'field' });
            return;
        }
        const others = this.allNodes().filter(isMachine).filter(m => m !== machine && m.field.ref === field);
        if (others.length > 0) {
            accept('error', `State field ${field.name} is already owned by another machine.`, { node: machine, property: 'field' });
        }
        const states = new Set(enumDecl.literals.map(l => l.name));
        for (const transition of machine.transitions) {
            [...transition.from, transition.to].forEach(state => {
                if (!states.has(state)) accept('error', `"${state}" is not a value of ${enumDecl.name}.`, { node: transition });
            });
        }
    }

    checkSetEffect(effect: SetEffect, accept: ValidationAcceptor): void {
        if (effect.field.ref?.modifiers.includes('state')) {
            accept('error', 'A state field changes only through a machine transition.', { node: effect, property: 'field' });
        }
    }

    checkPolicyScope(policy: Policy, accept: ValidationAcceptor): void {
        if (!isEntity(policy.$container) && (policy.operations.length > 0 || policy.fields.length > 0)) {
            accept('error', 'Operations and fields narrow entity policies only.', { node: policy });
        }
    }

    checkProjectionFields(projection: Projection, accept: ValidationAcceptor): void {
        const entity = projectionSourceEntity(projection);
        if (!entity) return;
        const names = new Set(entity.fields.map(f => f.name));
        for (const field of projection.fields.filter(f => !f.value && !names.has(f.name))) {
            accept('error', `${entity.name} has no field "${field.name}". Use "${field.name} = <expression>" for a computed field.`, { node: field, property: 'name' });
        }
    }

    checkEndpointShape(endpoint: Endpoint, accept: ValidationAcceptor): void {
        if (endpoint.target.ref?.$type === 'Query' && !endpoint.projection) {
            accept('error', 'An endpoint exposes query results only through a projection: add "as <Projection>".', { node: endpoint, property: 'target' });
        }
    }

    checkMigration(migration: Migration, accept: ValidationAcceptor): void {
        const ids = this.allStableIds();
        for (const step of migration.steps) {
            const exists = ids.has(step.target);
            if (step.$type === 'RemoveStep' ? exists : !exists) {
                accept('error', step.$type === 'RemoveStep'
                    ? `Removed element ${step.target} still exists.`
                    : `No element has stable id ${step.target}.`, { node: step, property: 'target' });
            }
        }
    }

    private allNodes(): AstNode[] {
        return this.services.shared.workspace.LangiumDocuments.all
            .flatMap(doc => AstUtils.streamAst(doc.parseResult.value))
            .toArray();
    }

    private allStableIds(): Map<string, number> {
        const counts = new Map<string, number>();
        for (const node of this.allNodes()) {
            const id = (node as AstNode & { id?: string }).id;
            if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
        }
        return counts;
    }
}

/** The top level declaration inside a module that owns this node. */
function memberOf(node: AstNode): AstNode | undefined {
    let current: AstNode | undefined = node;
    while (current && !isModule(current.$container)) current = current.$container;
    return current;
}

function isAllowed(from: AstNode, to: AstNode): boolean {
    const source = LAYER_OF[from.$type];
    const target = LAYER_OF[to.$type];
    if (source === target || target === 'cross') return true;
    switch (source) {
        case 'cross': return target === 'domain';
        case 'domain': return false;
        case 'behavior': return target === 'domain';
        case 'application': return target === 'domain' || target === 'behavior';
        case 'interface':
        case 'experience':
            return target === 'application' || isAction(to) || isEnum(to) || isValueType(to);
    }
}

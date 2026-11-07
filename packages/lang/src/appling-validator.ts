import { AstUtils, WorkspaceCache, type AstNode, type ValidationAcceptor, type ValidationChecks } from 'langium';
import {
    isAction, isBinaryExpr, isBoolExpr, isEntity, isExternal, isExternalOperation, isMemberExpr, isNameExpr, isEnum, isMachine, isMigration, isModule, isValueType,
    type ApplingAstType, type Endpoint, type External, type ExternalKey, type Interface, type Machine, type Migration, type MigrationStep, type Model,
    type Expr, type Policy, type Projection, type RenameStep, type SetEffect
} from './generated/ast.js';
import { namedPaths, projectionSourceEntity } from './appling-scope.js';
import { ExpressionTyper } from './appling-types.js';
import { doesTargets } from './appling-does.js';
import type { ApplingServices } from './appling-module.js';

export type Layer = 'cross' | 'domain' | 'behavior' | 'application' | 'interface' | 'experience';

export const LAYER_OF: Record<string, Layer> = {
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
        Model: [validator.checkLayerReferences, validator.checkTypes, validator.checkDoesNames],
        Machine: validator.checkMachine,
        SetEffect: validator.checkSetEffect,
        Policy: validator.checkPolicyScope,
        Projection: validator.checkProjectionFields,
        Endpoint: validator.checkEndpointShape,
        Migration: validator.checkMigration,
        ExternalKey: validator.checkExternalKey,
        External: validator.checkExternalUsed,
        Interface: validator.checkInterfaceSource
    };
    services.validation.ValidationRegistry.register(checks, validator);
}

export class ApplingValidator {

    /** The machines of the workspace by the field they govern, rebuilt when a document changes. */
    private readonly machines: WorkspaceCache<string, Map<AstNode, Machine[]>>;

    /** The externals some reference names, itself or through one of its operations, rebuilt when a document changes. */
    private readonly usedExternals: WorkspaceCache<string, Set<AstNode>>;

    constructor(private readonly services: ApplingServices) {
        this.machines = new WorkspaceCache(services.shared);
        this.usedExternals = new WorkspaceCache(services.shared);
    }

    checkLayerReferences(model: Model, accept: ValidationAcceptor): void {
        for (const node of AstUtils.streamAst(model)) {
            for (const ref of AstUtils.streamReferences(node)) {
                const target = AstUtils.getReferenceNodes(ref.reference)[0];
                const from = memberOf(node);
                const to = target && memberOf(target);
                if (!from || !to || !LAYER_OF[from.$type] || isAllowed(from, to)) continue;
                accept('error',
                    `${LAYER_OF[from.$type]} element ${from.$type} may not reference ${LAYER_OF[to.$type]} element ${to.$type} "${ref.reference.$refText}".`,
                    { node, property: ref.property, index: ref.index });
            }
        }
    }

    /** `@Name` in a `does` text must name a visible element, within the layer rules of a reference. */
    checkDoesNames(model: Model, accept: ValidationAcceptor): void {
        for (const node of AstUtils.streamAst(model)) {
            for (const { name, target } of doesTargets(node, this.services)) {
                if (!target) {
                    accept('error', `Unknown element "@${name}" in does.`, { node, property: 'does' });
                    continue;
                }
                const from = memberOf(node);
                const to = memberOf(target);
                if (!from || !to || isModule(from) || !LAYER_OF[from.$type] || isAllowed(from, to)) continue;
                accept('error',
                    `${LAYER_OF[from.$type]} element ${from.$type} may not reference ${LAYER_OF[to.$type]} element ${to.$type} "@${name}".`,
                    { node, property: 'does' });
            }
        }
    }

    checkTypes(model: Model, accept: ValidationAcceptor): void {
        const typer = new ExpressionTyper(this.services);
        typer.checkModel(model);
        for (const { node, message, property } of typer.problems) accept('error', message, { node, property });
    }

    checkMachine(machine: Machine, accept: ValidationAcceptor): void {
        const field = machine.field.ref;
        if (!field) return;
        const enumDecl = field.type.decl?.ref;
        if (!isEntity(field.$container) || !field.modifiers.includes('state') || !isEnum(enumDecl)) {
            accept('error', 'A machine must govern an entity field marked "state" with an enum type.', { node: machine, property: 'field' });
            return;
        }
        if ((this.machinesByField().get(field)?.length ?? 0) > 1) {
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
        if (!grantsByRole(policy.condition)) {
            accept('warning', 'A policy grants by role: every "||" branch needs actor.is(Role), or write { false }.', { node: policy, property: 'condition' });
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

    checkExternalKey(key: ExternalKey, accept: ValidationAcceptor): void {
        if (!key.type.primitive || key.type.many) {
            accept('error', `A ${key.kind} has a primitive type, not ${key.type.$cstNode?.text ?? 'this one'}.`, { node: key, property: 'type' });
        }
    }

    checkExternalUsed(external: External, accept: ValidationAcceptor): void {
        if (external.keys.length === 0 || this.externalsInUse().has(external)) return;
        accept('warning', `External ${external.name} declares settings or secrets, but nothing calls or names it.`, { node: external, property: 'name' });
    }

    checkInterfaceSource(api: Interface, accept: ValidationAcceptor): void {
        if (api.protocol !== 'webhook') return;
        if (!api.source) {
            accept('error', `A webhook interface names its vendor: "interface webhook ${api.name} from <External>".`, { node: api, property: 'name' });
        }
        if (api.endpoints.length === 0) accept('warning', `Webhook interface ${api.name} has no endpoints.`, { node: api, property: 'name' });
    }

    private externalsInUse(): Set<AstNode> {
        return this.usedExternals.get('used', () => {
            const used = new Set<AstNode>();
            for (const doc of this.services.shared.workspace.LangiumDocuments.all) {
                for (const node of AstUtils.streamAst(doc.parseResult.value)) {
                    for (const ref of AstUtils.streamReferences(node)) {
                        const target = AstUtils.getReferenceNodes(ref.reference)[0];
                        if (isExternal(target)) used.add(target);
                        if (isExternalOperation(target)) used.add(target.$container);
                    }
                }
            }
            return used;
        });
    }

    checkMigration(migration: Migration, accept: ValidationAcceptor): void {
        const module = migration.$container;
        const nameOf = (node: AstNode) => this.services.references.NameProvider.getName(node);
        const paths = new Set(module.members.flatMap(m => [...namedPaths(m, nameOf)].map(([path]) => path)));
        const steps = module.members.filter(isMigration).flatMap(m => m.steps);
        for (const step of migration.steps) {
            const path = step.$type === 'RenameStep' ? renamed(step) : step.target;
            const current = followSteps(path, steps.slice(steps.indexOf(step) + 1));
            if (current === undefined) continue;
            if (step.$type === 'RemoveStep' ? paths.has(current) : !paths.has(current)) {
                accept('error', step.$type === 'RemoveStep'
                    ? `Removed element ${current} still exists.`
                    : `Module ${module.name} has no element ${current}.`, { node: step, property: 'target' });
            }
        }
    }

    private machinesByField(): Map<AstNode, Machine[]> {
        return this.machines.get('byField', () => {
            const byField = new Map<AstNode, Machine[]>();
            const machines = this.services.shared.workspace.LangiumDocuments.all
                .flatMap(doc => AstUtils.streamAst(doc.parseResult.value))
                .filter(isMachine);
            for (const machine of machines) {
                const field = machine.field.ref;
                if (field) byField.set(field, [...(byField.get(field) ?? []), machine]);
            }
            return byField;
        });
    }
}

/** Where a path ends up after the later migration steps, or undefined when one of them removes it. */
function followSteps(path: string, steps: MigrationStep[]): string | undefined {
    for (const step of steps) {
        if (path !== step.target && !path.startsWith(`${step.target}.`)) continue;
        if (step.$type === 'RemoveStep') return undefined;
        if (step.$type === 'RenameStep') path = renamed(step) + path.slice(step.target.length);
    }
    return path;
}

function renamed(step: RenameStep): string {
    return step.target.replace(/[^.]+$/, step.newName);
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

/** `false`, or every `||` branch has a positive `actor.is(...)` among its `&&` conditions. */
function grantsByRole(condition: Expr): boolean {
    if (isBoolExpr(condition) && condition.value === 'false') return true;
    const split = (expr: Expr, op: string): Expr[] => isBinaryExpr(expr) && expr.op === op ? [...split(expr.left, op), ...split(expr.right, op)] : [expr];
    const isRole = (expr: Expr) => isMemberExpr(expr) && expr.call && expr.member === 'is' && isNameExpr(expr.receiver) && expr.receiver.name === 'actor';
    return split(condition, '||').every(branch => split(branch, '&&').some(isRole));
}

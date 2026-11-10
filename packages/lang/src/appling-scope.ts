import {
    AstUtils, DefaultScopeComputation, DefaultScopeProvider, EMPTY_SCOPE, MultiMap, MultiMapScope,
    type AstNode, type AstNodeDescription, type LangiumDocument, type ReferenceInfo, type Scope
} from 'langium';
import {
    isAction, isCallStep, isEndpoint, isDetailView, isExport, isExternalOperation, isHandler, isListView,
    isModule, isQuery, isScenario, isSetEffect, isSort, isTransition, isMachine, isForEffect, isUpdateEffect, isEntity,
    type Entity, type Expr, type Model, type Module, type Projection
} from './generated/ast.js';
import { ExpressionTyper } from './appling-types.js';
import { scenarioErrors } from './appling-scenario.js';
import type { ApplingServices } from './appling-module.js';

/**
 * Inside a module, nested elements are also visible by their dotted path (`Order.status`).
 * Across modules, only exported elements are visible, by their module path (`sales.Order`).
 */
export class ApplingScopeComputation extends DefaultScopeComputation {

    override async collectExportedSymbols(document: LangiumDocument): Promise<AstNodeDescription[]> {
        const exports: AstNodeDescription[] = [];
        const model = document.parseResult.value as Model;
        for (const module of AstUtils.streamAst(model).filter(isModule)) {
            const prefix = modulePath(module);
            const exported = new Set(module.exports.flatMap(e => e.names.map(n => n.$refText)));
            for (const member of module.members.filter(m => exported.has(this.nameProvider.getName(m) ?? ''))) {
                for (const [path, node] of namedPaths(member, this.nameProvider.getName.bind(this.nameProvider))) {
                    exports.push(this.descriptions.createDescription(node, `${prefix}.${path}`, document));
                }
            }
        }
        return exports;
    }

    protected override addLocalSymbol(node: AstNode, document: LangiumDocument, symbols: MultiMap<AstNode, AstNodeDescription>): void {
        super.addLocalSymbol(node, document, symbols);
        let path = this.nameProvider.getName(node);
        let ancestor = node.$container;
        while (path && ancestor && !isModule(ancestor)) {
            const ancestorName = this.nameProvider.getName(ancestor);
            path = ancestorName ? `${ancestorName}.${path}` : undefined;
            ancestor = ancestor.$container;
            if (path && ancestor) {
                symbols.add(ancestor, this.descriptions.createDescription(node, path, document));
            }
        }
    }
}

export class ApplingScopeProvider extends DefaultScopeProvider {

    constructor(private readonly services: ApplingServices) {
        super(services);
    }

    /** Resolves a dotted name written inside an expression, the way a reference of the given type would. */
    lookup(container: AstNode, type: string, name: string): AstNode | undefined {
        return this.scopeOf(container, type).getElement(name)?.node;
    }

    /** Resolves a dotted name to an element of any kind, as visible from the container (`@Name` in `does`). */
    lookupElement(container: AstNode, name: string): AstNode | undefined {
        return this.scopeOf(container).getElement(name)?.node;
    }

    override getScope(context: ReferenceInfo): Scope {
        const node = context.container;
        if (context.property === 'picks' && (isEndpoint(node) || isListView(node) || isDetailView(node))) {
            return this.createScopeForNodes(node.projection?.ref?.fields ?? []);
        }
        if (isExport(node)) {
            return this.createScopeForNodes(node.$container.members);
        }
        if (isSort(node)) {
            return this.fieldsOf(AstUtils.getContainerOfType(node, isQuery)?.entity?.ref);
        }
        if (isSetEffect(node)) {
            // Inside `update path { … }` a set changes the record the path leads to.
            const update = node.$container;
            return this.fieldsOf(isUpdateEffect(update) ? updatedEntity(update.target, this.services) : effectEntity(node));
        }
        if (isForEffect(node)) {
            return this.fieldsOf(effectEntity(node));
        }
        if (isHandler(node)) {
            const target = AstUtils.getContainerOfType(node, isCallStep)?.call.target.ref;
            return isAction(target) || isExternalOperation(target) ? this.createScopeForNodes(target.errors) : EMPTY_SCOPE;
        }
        if (isScenario(node) && context.property === 'error') {
            return this.createScopeForNodes(scenarioErrors(node));
        }
        return super.getScope(context);
    }

    private scopeOf(container: AstNode, type?: string): Scope {
        const symbols = AstUtils.getDocument(container).localSymbols;
        const local: AstNode[] = [];
        for (let node: AstNode | undefined = container; node; node = node.$container) local.push(node);
        return local.reverse().reduce<Scope>((outer, node) => symbols?.has(node)
            ? this.createScope(symbols.getStream(node).filter(d => !type || this.reflection.isSubtype(d.type, type)), outer)
            : outer, new MultiMapScope(this.indexManager.allElements(type)));
    }

    private fieldsOf(entity: Entity | undefined): Scope {
        return entity ? this.createScopeForNodes(entity.fields) : EMPTY_SCOPE;
    }
}

export function modulePath(module: Module): string {
    const parent = AstUtils.getContainerOfType(module.$container, isModule);
    return parent ? `${modulePath(parent)}.${module.name}` : module.name;
}

export function projectionSourceEntity(projection: Projection): Entity | undefined {
    const source = projection.source.ref;
    return isQuery(source) ? source.entity.ref : source;
}

/** The entity of the action or of the machine an effect belongs to. */
export function effectEntity(node: AstNode): Entity | undefined {
    const action = AstUtils.getContainerOfType(node, isAction);
    if (action) return action.entity?.ref;
    const transition = AstUtils.getContainerOfType(node, isTransition);
    const machine = transition && AstUtils.getContainerOfType(transition, isMachine);
    return machine?.field.ref?.$container as Entity | undefined;
}

/** The entity of the record a relationship path such as `item.product` leads to, by the type of the path. */
export function updatedEntity(path: Expr | undefined, services: ApplingServices): Entity | undefined {
    const found = path && new ExpressionTyper(services).typeOf(path);
    // For a list, which the validator reports, the sets still resolve against its records.
    const type = found?.kind === 'list' ? found.item : found;
    return type?.kind === 'decl' && isEntity(type.decl) ? type.decl : undefined;
}

export function* namedPaths(node: AstNode, nameOf: (n: AstNode) => string | undefined, prefix = ''): Generator<[string, AstNode]> {
    const name = nameOf(node);
    if (!name) return;
    const path = prefix ? `${prefix}.${name}` : name;
    yield [path, node];
    for (const child of AstUtils.streamContents(node)) {
        yield* namedPaths(child, nameOf, path);
    }
}

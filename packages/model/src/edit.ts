import { AstUtils, CstUtils, GrammarAST, GrammarUtils, URI, type AstNode, type CstNode, type LangiumDocument, type LeafCstNode } from 'langium';
import {
    ExpressionTyper, LAYER_OF, buildSources, errorsOf, isEntity, isEnumLiteral, isField, isMachine, isMemberExpr, isMessages,
    isMigration, isModule, isProjection, isRenameStep, modulePath, printRange, projectionSourceEntity,
    type MigrationStep, type Model, type Workspace
} from '@appling/lang';
import { qualifiedNames } from './graph.js';
import { migrationBlockName, type Release } from './release.js';

export type EditOperation =
    | { op: 'add'; parent: string; source: string }
    | { op: 'rename'; target: string; name: string }
    | { op: 'retype'; target: string; type: string }
    | { op: 'remove'; target: string }
    | { op: 'set'; target: string; property: string; value: string };

export interface TextEdit {
    uri: string;
    offset: number;
    length: number;
    text: string;
}

export type EditResult =
    | { ok: true; sources: Record<string, string>; edits: TextEdit[] }
    | { ok: false; errors: string[] };

type Sources = Record<string, string>;

interface Splice {
    uri: string;
    start: number;
    end: number;
    text: string;
}

class Rejected extends Error { }

/**
 * Applies one edit to sources keyed by URI. The touched region is printed canonically, the result is
 * validated, and the edit is rejected when it introduces errors. The returned text edits are minimal.
 * With a release, renaming, retyping or removing a released L1 element also appends a migration step.
 */
export async function applyEdit(sources: Sources, operation: EditOperation, options: { release?: Release } = {}): Promise<EditResult> {
    const workspace = await buildSources(sources);
    let changed: Sources;
    try {
        const step = options.release && migrationStep(workspace, operation, options.release);
        changed = await perform(workspace, sources, operation);
        if (step) changed = await appendStep(changed, step);
    } catch (error) {
        if (error instanceof Rejected) return { ok: false, errors: [error.message] };
        throw error;
    }
    const added = newErrors(errorsOf(workspace), errorsOf(await buildSources(changed)));
    if (added.length) return { ok: false, errors: added };
    return { ok: true, sources: changed, edits: diff(sources, changed) };
}

async function perform(workspace: Workspace, sources: Sources, operation: EditOperation): Promise<Sources> {
    const find = finder(workspace);
    switch (operation.op) {
        case 'add':
            return add(workspace, sources, find(operation.parent), operation.parent, operation.source);
        case 'rename':
            return splice(sources, renameSplices(workspace, find(operation.target), operation.name));
        case 'retype':
            return set(workspace, sources, find(operation.target), 'type', operation.type);
        case 'remove':
            return remove(workspace, sources, find(operation.target));
        case 'set':
            return set(workspace, sources, find(operation.target), operation.property, operation.value);
    }
}

function finder(workspace: Workspace): (qn: string) => AstNode {
    const index = new Map([...qualifiedNames(modelsOf(workspace))].map(([node, qn]) => [qn, node]));
    return qn => {
        const node = index.get(qn);
        if (!node) throw new Rejected(`No element ${qn}.`);
        return node;
    };
}

interface PendingStep {
    module: string;
    block: string;
    text: string;
}

/** The step that records an edit of a released L1 element, written with the element's path before the edit. */
function migrationStep(workspace: Workspace, operation: EditOperation, release: Release): PendingStep | undefined {
    if (operation.op !== 'rename' && operation.op !== 'retype' && operation.op !== 'remove') return undefined;
    const node = finder(workspace)(operation.target);
    const module = AstUtils.getContainerOfType(node.$container, isModule);
    let member: AstNode = node;
    while (member.$container && member.$container !== module) member = member.$container;
    if (!module || !nameOf(node) || LAYER_OF[member.$type] !== 'domain') return undefined;
    const path = pathInModule(node, module).join('.');
    const block = migrationBlockName(release.version);
    const since = module.members.filter(isMigration).find(m => m.name === block)?.steps ?? [];
    if (!release.graph.nodes.some(n => n.qn === `${modulePath(module)}.${releasedPath(path, since)}`)) return undefined;
    const text = operation.op === 'rename' ? `rename ${path} -> ${operation.name}`
        : operation.op === 'retype' ? `retype ${path}: ${GrammarUtils.findNodeForProperty(node.$cstNode, 'type')?.text} -> ${operation.type}`
        : `remove ${path}`;
    return { module: modulePath(module), block, text };
}

/** Undoes the renames recorded since the release, giving the path the element had in the release. */
function releasedPath(path: string, steps: MigrationStep[]): string {
    for (const step of [...steps].reverse()) {
        if (!isRenameStep(step)) continue;
        const renamed = step.target.replace(/[^.]+$/, step.newName);
        if (path === renamed || path.startsWith(`${renamed}.`)) path = step.target + path.slice(renamed.length);
    }
    return path;
}

async function appendStep(sources: Sources, step: PendingStep): Promise<Sources> {
    const workspace = await buildSources(sources);
    const find = finder(workspace);
    const block = `${step.module}.${step.block}`;
    const exists = [...qualifiedNames(modelsOf(workspace)).values()].includes(block);
    return exists
        ? add(workspace, sources, find(block), block, step.text)
        : add(workspace, sources, find(step.module), step.module, `migration ${step.block} { ${step.text} }`);
}

/** Inserts the source at the last position inside the parent where it parses as one more child of the parent. */
function add(workspace: Workspace, sources: Sources, parent: AstNode, parentQn: string, source: string): Sources {
    const uri = uriOf(parent);
    const text = sources[uri];
    const children = AstUtils.streamContents(parent).count();
    for (const offset of insertionPoints(parent)) {
        const candidate = text.slice(0, offset) + ' ' + source + text.slice(offset);
        const document = parse(workspace, uri, candidate);
        const updated = nodeAt(document, parent.$cstNode!.offset, parent.$type);
        if (!hasSyntaxErrors(document) && updated && AstUtils.streamContents(updated).count() === children + 1) {
            return canonical(workspace, { ...sources, [uri]: candidate }, uri, offset + 1);
        }
    }
    throw new Rejected(`"${source}" does not fit into ${parentQn}.`);
}

function insertionPoints(parent: AstNode): number[] {
    const braces = ownLeaves(parent).filter(l => l.text === '{').map(l => l.end);
    const children = AstUtils.streamContents(parent).map(c => c.$cstNode!.end).toArray();
    return [...new Set([...braces, ...children])].sort((a, b) => b - a);
}

/** Renames an element and everything that names it: references, names in expressions, transitions, exports, message keys. */
function renameSplices(workspace: Workspace, node: AstNode, name: string): Splice[] {
    const models = modelsOf(workspace);
    const typer = new ExpressionTyper(workspace.services);
    models.forEach(m => typer.checkModel(m));
    const all = models.flatMap(m => AstUtils.streamAst(m).toArray());
    const splices: Splice[] = [];

    for (const renamed of [node, ...boundProjectionFields(node, all)]) {
        const old = nameOf(renamed)!;
        splices.push(tokenSplice(renamed, 'name', name));
        for (const source of all) {
            for (const ref of AstUtils.streamReferences(source)) {
                const depth = depthBelow(AstUtils.getReferenceNodes(ref.reference)[0], renamed);
                const segments = ref.reference.$refNode ? nameLeaves(ref.reference.$refNode) : [];
                const segment = segments[segments.length - 1 - depth];
                if (depth >= 0 && segment?.text === old) splices.push(leafSplice(segment, name));
            }
        }
        for (const [expr, target] of typer.targets) {
            let depth = depthBelow(target, renamed);
            if (depth < 0) continue;
            let step: AstNode | undefined = expr;
            for (; depth > 0 && step; depth--) step = isMemberExpr(step) ? step.receiver : undefined;
            if (!step) continue;
            const property = isMemberExpr(step) ? 'member' : 'name';
            if ((step as unknown as Record<string, unknown>)[property] === old) splices.push(tokenSplice(step, property, name));
        }
        if (isEnumLiteral(renamed)) {
            for (const machine of all.filter(isMachine).filter(m => m.field.ref?.type.decl?.ref === renamed.$container)) {
                for (const transition of machine.transitions) {
                    for (const cst of [...GrammarUtils.findNodesForProperty(transition.$cstNode, 'from'), ...GrammarUtils.findNodesForProperty(transition.$cstNode, 'to')]) {
                        if (cst.text === old) splices.push(cstSplice(transition, cst, name));
                    }
                }
            }
        }
        const module = AstUtils.getContainerOfType(renamed.$container, isModule);
        if (module && renamed.$container === module) {
            for (const exp of module.exports) {
                for (const cst of GrammarUtils.findNodesForProperty(exp.$cstNode, 'names')) {
                    if (cst.text === old) splices.push(cstSplice(exp, cst, name));
                }
            }
        }
        const path = module ? pathInModule(renamed, module) : [];
        for (const message of module?.members.filter(isMessages).flatMap(m => m.entries) ?? []) {
            const keys = nameLeaves(GrammarUtils.findNodeForProperty(message.$cstNode, 'key')!);
            if (path.length && path.every((segment, i) => keys[i]?.text === segment)) splices.push(leafSplice(keys[path.length - 1], name));
        }
    }
    return splices;
}

/** Projection fields without a value copy an entity field by name, so they follow its rename. */
function boundProjectionFields(node: AstNode, all: AstNode[]): AstNode[] {
    if (!isField(node) || !isEntity(node.$container)) return [];
    return all.filter(isProjection)
        .filter(p => projectionSourceEntity(p) === node.$container)
        .flatMap(p => p.fields.filter(f => !f.value && f.name === node.name));
}

function remove(workspace: Workspace, sources: Sources, node: AstNode): Sources {
    const parent = node.$container!;
    const splices = [removal(node, node.$cstNode!)];
    if (isModule(parent)) {
        for (const exp of parent.exports) {
            const names = GrammarUtils.findNodesForProperty(exp.$cstNode, 'names').filter(c => c.text === nameOf(node));
            if (names.length === exp.names.length) splices.push(removal(exp, exp.$cstNode!));
            else splices.push(...names.map(c => removal(exp, c)));
        }
    }
    return canonical(workspace, splice(sources, splices), uriOf(parent), parent.$cstNode!.offset);
}

/** Replaces a property's text, removes it when the value is empty, or inserts it with its keyword when absent. */
function set(workspace: Workspace, sources: Sources, node: AstNode, property: string, value: string): Sources {
    const uri = uriOf(node);
    const offset = node.$cstNode!.offset;
    const nodes = GrammarUtils.findNodesForProperty(node.$cstNode, property);
    if (nodes.length) {
        const range = { offset: nodes[0].offset, end: nodes[nodes.length - 1].end };
        if (value) return canonical(workspace, splice(sources, [{ uri, start: range.offset, end: range.end, text: value }]), uri, offset);
        const keyword = previousLeaf(node, range.offset);
        const start = keyword && keyword.astNode === node && GrammarAST.isKeyword(keyword.grammarSource) && /^[a-z=]/.test(keyword.text) ? keyword.offset : range.offset;
        return canonical(workspace, splice(sources, [{ uri, start, end: range.end, text: '' }]), uri, offset);
    }
    if (!value) return sources;
    const keyword = keywordBefore(workspace, node.$type, property);
    const text = ` ${keyword ? `${keyword} ` : ''}${value}`;
    for (const at of [...new Set(ownLeaves(node).map(l => l.end))].sort((a, b) => b - a)) {
        const candidate = sources[uri].slice(0, at) + text + sources[uri].slice(at);
        const document = parse(workspace, uri, candidate);
        const updated = nodeAt(document, offset, node.$type);
        if (!hasSyntaxErrors(document) && updated && GrammarUtils.findNodesForProperty(updated.$cstNode, property).length) {
            return canonical(workspace, { ...sources, [uri]: candidate }, uri, offset);
        }
    }
    throw new Rejected(`Cannot set ${property} on ${node.$type}.`);
}

function keywordBefore(workspace: Workspace, type: string, property: string): string | undefined {
    for (const rule of workspace.services.Grammar.rules.filter(GrammarAST.isParserRule)) {
        for (const assignment of AstUtils.streamAllContents(rule).filter(GrammarAST.isAssignment)) {
            if (assignment.feature !== property || GrammarUtils.getTypeName(rule) !== type) continue;
            const group = assignment.$container;
            if (!GrammarAST.isGroup(group)) return undefined;
            const previous = group.elements[group.elements.indexOf(assignment) - 1];
            return GrammarAST.isKeyword(previous) ? previous.value : undefined;
        }
    }
    return undefined;
}

/** Reprints the element of the given type that starts at offset, with the gaps around it. */
function canonical(workspace: Workspace, sources: Sources, uri: string, offset: number): Sources {
    const document = parse(workspace, uri, sources[uri]);
    if (hasSyntaxErrors(document)) throw new Rejected('The edit does not parse.');
    const leaf = CstUtils.findLeafNodeAtOffset(document.parseResult.value.$cstNode!, offset);
    let node: AstNode | undefined = leaf?.astNode;
    const qns = qualifiedNames([document.parseResult.value as Model]);
    while (node && !qns.has(node)) node = node.$container;
    if (!node) return sources;
    const { start, end, text } = printRange(node);
    return splice(sources, [{ uri, start, end, text }]);
}

/** Removes a node's text with the gap before it, or the separating comma when it sits in a list. */
function removal(owner: AstNode, cst: CstNode): Splice {
    const leaves = documentLeaves(owner);
    const first = leaves.findIndex(l => l.offset >= cst.offset);
    const last = leaves.findLastIndex(l => l.end <= cst.end);
    const uri = uriOf(owner);
    if (leaves[first - 1]?.text === ',') return { uri, start: leaves[first - 2].end, end: cst.end, text: '' };
    if (leaves[last + 1]?.text === ',') return { uri, start: cst.offset, end: leaves[last + 2]?.offset ?? leaves[last + 1].end, text: '' };
    return { uri, start: leaves[first - 1]?.end ?? 0, end: cst.end, text: '' };
}

function splice(sources: Sources, splices: Splice[]): Sources {
    const result = { ...sources };
    const unique = [...new Map(splices.map(s => [`${s.uri} ${s.start} ${s.end}`, s])).values()];
    for (const uri of new Set(unique.map(s => s.uri))) {
        const ordered = unique.filter(s => s.uri === uri).sort((a, b) => b.start - a.start);
        ordered.forEach((s, i) => {
            if (i > 0 && s.end > ordered[i - 1].start) throw new Rejected('The edit touches overlapping text.');
        });
        result[uri] = ordered.reduce((text, s) => text.slice(0, s.start) + s.text + text.slice(s.end), result[uri]);
    }
    return result;
}

function diff(before: Sources, after: Sources): TextEdit[] {
    return Object.keys(after).filter(uri => before[uri] !== after[uri]).map(uri => {
        const [a, b] = [before[uri], after[uri]];
        let prefix = 0;
        while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
        let suffix = 0;
        while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
        return { uri, offset: prefix, length: a.length - prefix - suffix, text: b.slice(prefix, b.length - suffix) };
    });
}

function newErrors(before: string[], after: string[]): string[] {
    const remaining = [...before];
    return after.filter(message => {
        const i = remaining.indexOf(message);
        if (i < 0) return true;
        remaining.splice(i, 1);
        return false;
    });
}

/** How many named elements lie between an element and a target inside it (0 for the element itself), or -1. */
function depthBelow(target: AstNode | undefined, element: AstNode): number {
    let depth = 0;
    for (let node = target; node; node = node.$container) {
        if (node === element) return depth;
        if (nameOf(node)) depth++;
    }
    return -1;
}

function pathInModule(node: AstNode, module: AstNode): string[] {
    const path: string[] = [];
    for (let current: AstNode | undefined = node; current && current !== module; current = current.$container) {
        const name = nameOf(current);
        if (name) path.unshift(name);
    }
    return path;
}

function nameOf(node: AstNode): string | undefined {
    const name = (node as { name?: unknown }).name;
    return typeof name === 'string' ? name : undefined;
}

function parse(workspace: Workspace, uri: string, text: string): LangiumDocument {
    return workspace.services.shared.workspace.LangiumDocumentFactory.fromString(text, URI.parse(uri));
}

function hasSyntaxErrors(document: LangiumDocument): boolean {
    return document.parseResult.lexerErrors.length > 0 || document.parseResult.parserErrors.length > 0;
}

function nodeAt(document: LangiumDocument, offset: number, type: string): AstNode | undefined {
    let node = CstUtils.findLeafNodeAtOffset(document.parseResult.value.$cstNode!, offset)?.astNode;
    while (node && node.$type !== type) node = node.$container;
    return node;
}

function modelsOf(workspace: Workspace): Model[] {
    return workspace.documents.map(d => d.parseResult.value as Model);
}

function uriOf(node: AstNode): string {
    return AstUtils.getDocument(node).uri.toString();
}

function documentLeaves(node: AstNode): LeafCstNode[] {
    return CstUtils.flattenCst(AstUtils.findRootNode(node).$cstNode!).filter(l => !l.hidden && l.tokenType.name !== 'WS').toArray();
}

/** Leaves that belong to the node itself or to its non element parts, not to nested elements. */
function ownLeaves(node: AstNode): LeafCstNode[] {
    const qns = qualifiedNames([AstUtils.findRootNode(node) as Model]);
    return CstUtils.flattenCst(node.$cstNode!).filter(l => {
        if (l.hidden) return false;
        let owner: AstNode | undefined = l.astNode;
        while (owner && !qns.has(owner)) owner = owner.$container;
        return owner === node;
    }).toArray();
}

function previousLeaf(node: AstNode, offset: number): LeafCstNode | undefined {
    return documentLeaves(node).filter(l => l.end <= offset).pop();
}

function nameLeaves(cst: CstNode): LeafCstNode[] {
    return CstUtils.flattenCst(cst).filter(l => !l.hidden && l.text !== '.').toArray();
}

function tokenSplice(node: AstNode, property: string, text: string): Splice {
    return cstSplice(node, GrammarUtils.findNodeForProperty(node.$cstNode, property)!, text);
}

function cstSplice(node: AstNode, cst: CstNode, text: string): Splice {
    return { uri: uriOf(node), start: cst.offset, end: cst.end, text };
}

function leafSplice(leaf: LeafCstNode, text: string): Splice {
    return { uri: uriOf(leaf.astNode), start: leaf.offset, end: leaf.end, text };
}

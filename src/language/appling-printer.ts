import { AstUtils, CstUtils, GrammarUtils, type AstNode, type LeafCstNode } from 'langium';
import { isModel, reflection } from './generated/ast.js';

/**
 * Canonical text form. Every gap between two tokens gets exactly one spelling, so
 * print(parse(text)) is stable and two equal models print identically. Comments are kept.
 */

const INDENT = '  ';
const BLOCKS = new Set([
    'Module', 'Enum', 'ValueType', 'Entity', 'Event', 'Action', 'Machine', 'Query', 'Projection',
    'External', 'UseCase', 'Interface', 'Page', 'Navigation', 'NavItem', 'Messages', 'Migration'
]);
const CLAUSES = new Set(['input', 'effect', 'errors', 'consistency', 'where', 'sort', 'paginate', 'auth', 'limit', 'cors']);
const INLINE_BRACES_AFTER = new Set(['where']);
const CALLS = new Set(['NameExpr', 'MemberExpr', 'Call']);
const NO_SPACE_BEFORE = new Set([',', ')', ']', '.', ':', '?']);
const NO_SPACE_AFTER = new Set(['(', '[', '.']);

export function hasStableId(node: AstNode): boolean {
    return reflection.getTypeMetaData(node.$type).properties.id !== undefined;
}

export function print(root: AstNode, newId: () => string): string {
    const inserts = missingIdInserts(root, newId);
    const braces: boolean[] = [];
    let out = '';
    let prev: LeafCstNode | undefined;
    let opened = false;

    for (const leaf of CstUtils.flattenCst(root.$cstNode!)) {
        if (leaf.tokenType.name === 'WS') continue;
        const closed = !leaf.hidden && leaf.text === '}' && braces.pop() === true;
        if (prev) {
            const depth = braces.filter(Boolean).length;
            out += separator(prev, leaf, depth, opened, closed);
        }
        out += leaf.text + (inserts.get(leaf.end) ?? '');
        opened = false;
        if (!leaf.hidden && leaf.text === '{') {
            opened = BLOCKS.has(leaf.astNode.$type) && !INLINE_BRACES_AFTER.has(prev?.text ?? '');
            braces.push(opened);
        }
        prev = leaf;
    }
    return out + '\n';
}

function separator(prev: LeafCstNode, leaf: LeafCstNode, depth: number, opened: boolean, closed: boolean): string {
    const lineBreak = (blankAllowed: boolean) =>
        (blankAllowed && hasBlankLine(prev, leaf) ? '\n\n' : '\n') + INDENT.repeat(depth);

    if (leaf.hidden || prev.tokenType.name === 'ML_COMMENT') {
        return sameLine(prev, leaf) ? ' ' : lineBreak(!opened && !closed);
    }
    if (opened || closed) return lineBreak(false);
    if (prev.tokenType.name === 'SL_COMMENT') return lineBreak(true);
    if (startsLine(prev, leaf)) return lineBreak(true);
    return inlineSpace(prev, leaf);
}

function startsLine(prev: LeafCstNode, leaf: LeafCstNode): boolean {
    if (prev.text === ',' || isClauseKeyword(prev)) return false;
    return isClauseKeyword(leaf) || isMemberStart(leaf);
}

function isClauseKeyword(leaf: LeafCstNode): boolean {
    return CLAUSES.has(leaf.text) && BLOCKS.has(leaf.astNode.$type) && insideBraces(leaf.astNode, leaf.offset);
}

/** True when the leaf is the first token of a declaration that sits directly inside a block. */
function isMemberStart(leaf: LeafCstNode): boolean {
    let node: AstNode | undefined = leaf.astNode;
    while (node && firstTokenOffset(node) === leaf.offset) {
        const container: AstNode | undefined = node.$container;
        if (!container) return false;
        if (isModel(container)) return true;
        if (BLOCKS.has(container.$type) && insideBraces(container, leaf.offset)) return true;
        node = container;
    }
    return false;
}

function inlineSpace(prev: LeafCstNode, leaf: LeafCstNode): string {
    if (NO_SPACE_BEFORE.has(leaf.text) || NO_SPACE_AFTER.has(prev.text)) return '';
    if (leaf.text === '[' && leaf.astNode.$type === 'TypeRef') return '';
    if (leaf.text === '(' && CALLS.has(leaf.astNode.$type) && prev.astNode === leaf.astNode) return '';
    if (prev.astNode.$type === 'UnaryExpr' && firstTokenOffset(prev.astNode) === prev.offset) return '';
    return ' ';
}

function insideBraces(node: AstNode, offset: number): boolean {
    const brace = GrammarUtils.findNodeForKeyword(node.$cstNode, '{');
    return brace !== undefined && brace.offset < offset;
}

function firstToken(node: AstNode): LeafCstNode | undefined {
    return CstUtils.flattenCst(node.$cstNode!).find(l => !l.hidden && l.tokenType.name !== 'WS');
}

function firstTokenOffset(node: AstNode): number | undefined {
    return firstToken(node)?.offset;
}

function sameLine(a: LeafCstNode, b: LeafCstNode): boolean {
    return a.range.end.line === b.range.start.line;
}

function hasBlankLine(a: LeafCstNode, b: LeafCstNode): boolean {
    const startsModule = isModel(b.astNode.$container) && b.offset === firstTokenOffset(b.astNode);
    return b.range.start.line - a.range.end.line > 1 || (startsModule && !a.hidden);
}

/** Where a missing stable id goes: after the name, label or path, otherwise after the leading keyword. */
function missingIdInserts(root: AstNode, newId: () => string): Map<number, string> {
    const inserts = new Map<number, string>();
    for (const node of AstUtils.streamAst(root)) {
        if (!hasStableId(node) || (node as AstNode & { id?: string }).id) continue;
        const cst = node.$cstNode;
        const anchor = GrammarUtils.findNodeForProperty(cst, 'name')
            ?? GrammarUtils.findNodeForProperty(cst, 'label')
            ?? GrammarUtils.findNodeForProperty(cst, 'path')
            ?? firstToken(node);
        if (anchor) inserts.set(anchor.end, ` ${newId()}`);
    }
    return inserts;
}

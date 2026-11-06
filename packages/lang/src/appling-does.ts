import { DefaultValueConverter, GrammarUtils, type AstNode, type CstNode, type GrammarAST, type ValueType } from 'langium';
import type { ApplingServices } from './appling-module.js';
import type { ApplingScopeProvider } from './appling-scope.js';

/**
 * The `does` clause: a plain text description on a declaration, written as `"..."` or as a text block
 * `"""..."""`. `@Name` inside the text names an element the way a qualified name does.
 */

/** Strips a text block's quotes, the line break after the opening quotes, and the common indentation of its lines. */
export function textBlockValue(raw: string): string {
    const lines = raw.slice(3, -3).split(/\r?\n/);
    if (lines.length > 1 && lines[0].trim() === '') lines.shift();
    if (lines.length > 1 && lines[lines.length - 1].trim() === '') lines.pop();
    const indents = lines.filter(l => l.trim() !== '').map(l => l.match(/^[ \t]*/)![0].length);
    const common = indents.length ? Math.min(...indents) : 0;
    return lines.map(l => l.trim() === '' ? '' : l.slice(common).trimEnd()).join('\n');
}

/** The canonical spelling of a text block whose content sits at the given indentation, the closing quotes one level out. */
export function printTextBlock(raw: string, indent: string, outer: string): string {
    const lines = textBlockValue(raw).split('\n');
    return `"""\n${lines.map(l => l ? indent + l : '').join('\n')}\n${outer}"""`;
}

export class ApplingValueConverter extends DefaultValueConverter {
    protected override runConverter(rule: GrammarAST.AbstractRule, input: string, cstNode: CstNode): ValueType {
        if (rule.name === 'TEXT_BLOCK') return textBlockValue(input);
        return super.runConverter(rule, input, cstNode);
    }
}

/** One `@Name` inside a `does` text: the name without `@`, and the document offsets of its first character and its end. */
export interface DoesName {
    name: string;
    offset: number;
    end: number;
}

// `@` starts a name only where it does not continue a word, so mail addresses stay text.
const NAME = /(?<![\w.@])@([_a-zA-Z]\w*(?:\.[_a-zA-Z]\w*)*)/g;

/** The `@Name` occurrences in a node's own `does` text, read from the source so offsets stay exact. */
export function doesNames(node: AstNode): DoesName[] {
    if (typeof (node as { does?: unknown }).does !== 'string') return [];
    const cst = GrammarUtils.findNodeForProperty(node.$cstNode, 'does');
    if (!cst) return [];
    return [...cst.text.matchAll(NAME)].map(m => ({
        name: m[1],
        offset: cst.offset + m.index + 1,
        end: cst.offset + m.index + m[0].length
    }));
}

/** Each `@Name` of a node's `does` text with the element it names, or undefined when nothing visible has that name. */
export function doesTargets(node: AstNode, services: ApplingServices): Array<DoesName & { target?: AstNode }> {
    const scope = services.references.ScopeProvider as ApplingScopeProvider;
    return doesNames(node).map(name => ({ ...name, target: scope.lookupElement(node, name.name) }));
}

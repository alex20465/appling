import { AstUtils, DefaultTokenBuilder, GrammarAST, type Grammar, type TokenBuilderOptions } from 'langium';

/**
 * Lexes a keyword that is also a valid name (listed in the `Ident` rule) as a name when `:` follows it.
 * No rule puts `:` after a keyword, and the parser cannot look past the end of a field, so without this
 * `state: S` after a field would be read as a `state` modifier of that field.
 */
export class ApplingTokenBuilder extends DefaultTokenBuilder {

    override buildTokens(grammar: Grammar, options?: TokenBuilderOptions): ReturnType<DefaultTokenBuilder['buildTokens']> {
        const tokens = super.buildTokens(grammar, options);
        const ident = grammar.rules.find(rule => rule.name === 'Ident');
        const names = new Set(ident ? AstUtils.streamAllContents(ident).filter(GrammarAST.isKeyword).map(k => k.value) : []);
        for (const token of Array.isArray(tokens) ? tokens : []) {
            if (!names.has(token.name)) continue;
            const pattern = new RegExp(`${token.name}(?!\\w|\\s*:)`, 'y');
            token.PATTERN = (text: string, offset: number) => {
                pattern.lastIndex = offset;
                return pattern.exec(text);
            };
            token.START_CHARS_HINT = [token.name[0]];
            token.LINE_BREAKS = false;
        }
        return tokens;
    }
}

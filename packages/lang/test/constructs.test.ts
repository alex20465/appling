import { expect, test } from 'vitest';
import { AstUtils, CstUtils, GrammarAST, isLeafCstNode, type Grammar } from 'langium';
import { buildWorkspace, constructs, errors } from './workspace.js';

/**
 * The coverage fixture is what the codegen coverage tests plan per extension.
 * It has to stay valid and keep using every construct when the grammar grows.
 */
test('the coverage fixture is valid and uses every AST type and keyword of the grammar', async () => {
    const { documents, services } = await buildWorkspace(constructs());
    expect(errors(documents)).toEqual([]);

    const reflection = services.shared.AstReflection;
    const all = reflection.getAllTypes();
    const concrete = all.filter(type => !all.some(other => other !== type && reflection.isSubtype(other, type)));
    const types = new Set<string>();
    const keywords = new Set<string>();
    for (const doc of documents) {
        for (const node of AstUtils.streamAst(doc.parseResult.value)) types.add(node.$type);
        for (const leaf of CstUtils.streamCst(doc.parseResult.value.$cstNode!)) {
            // The token type, not the grammar source: a keyword lexed inside the Ident rule has a rule call as its source.
            if (isLeafCstNode(leaf)) keywords.add(leaf.tokenType.name);
        }
    }
    expect(concrete.filter(type => !types.has(type))).toEqual([]);

    const grammar = services.Grammar as Grammar;
    const declared = new Set(AstUtils.streamAllContents(grammar).filter(GrammarAST.isKeyword).map(k => k.value));
    expect([...declared].filter(k => !keywords.has(k)).sort()).toEqual([]);
});

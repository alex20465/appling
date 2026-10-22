import { expect, test } from 'vitest';
import type { Model } from '@appling/lang';
import { buildWorkspace, examples } from '../../lang/test/workspace.js';
import { buildGraph, dependencies } from '../src/index.js';

async function graphOf(sources: Record<string, string>) {
    const { documents, services } = await buildWorkspace(sources);
    return buildGraph(documents.map(doc => doc.parseResult.value as Model), services);
}

test('graph of examples', async () => {
    const graph = await graphOf(examples());
    expect(graph).toMatchSnapshot();
    expect(dependencies(graph)).toEqual([{ from: 'sales', to: 'crm', count: 7 }, { from: 'crm', to: 'sales', count: 1 }]);
});

test('unnamed elements get derived keys, with an ordinal for duplicates', async () => {
    const graph = await graphOf({
        'm.appling': `module m {
            enum S { a b }
            entity E {
                s: S state
                invariant "positive" { true }
                policy read { true }
                policy read { false }
                policy read fields s { true }
            }
            action Go on E { }
            machine F on E.s { transition a, b -> b via Go }
        }`
    });
    expect(graph.nodes.map(n => n.qn)).toEqual(expect.arrayContaining([
        'm.E.invariant["positive"]', 'm.E.policy[read]', 'm.E.policy[read]#2', 'm.E.policy[read fields s]', 'm.F.transition[a,b->b]'
    ]));
});

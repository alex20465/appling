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
    expect(dependencies(graph)).toEqual([{ from: 'sales', to: 'crm', count: 7 }, { from: 'crm', to: 'sales', count: 2 }]);
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

test('an enum value named with its enum is data like a bare value', async () => {
    const graph = await graphOf({ 'm.appling': 'module m { enum Scope { operator } entity Key { scope: Scope default Scope.operator } }' });
    expect(graph.nodes.find(n => n.qn === 'm.Key.scope')!.data.default).toEqual({ $type: 'NameExpr', name: 'operator', type: 'Scope', target: 'm.Scope.operator' });
    expect(graph.edges).toContainEqual({ from: 'm.Key.scope', to: 'm.Scope.operator', kind: 'uses' });
});

test('does is a prop and its @names are uses edges', async () => {
    const graph = await graphOf({ 'm.appling': 'module m { entity Account { email: String } action Close on Account does "Closes @Account.email" { } }' });
    expect(graph.nodes.find(n => n.qn === 'm.Close')!.props.does).toBe('Closes @Account.email');
    expect(graph.edges).toContainEqual({ from: 'm.Close', to: 'm.Account.email', kind: 'uses' });
});

test('actor.f declared by several actors uses every candidate field', async () => {
    const graph = await graphOf({ 'shop.appling': `module shop {
      role Buyer
      role Seller
      entity Customer { name: String }
      entity Vendor { name: String }
      actor human Shopper roles Buyer { account: Customer }
      actor human Merchant roles Seller { account: Vendor }
      entity Offer {
        vendor: Vendor
        policy read { actor.is(Seller) && vendor == actor.account }
      }
    }` });
    const uses = graph.edges.filter(e => e.kind === 'uses' && e.to.endsWith('.account')).map(e => e.to).sort();
    expect(uses).toEqual(['shop.Merchant.account', 'shop.Shopper.account']);
});

import { expect, test } from 'vitest';
import type { Model } from '@appling/lang';
import { buildGraph } from '@appling/model';
import { buildWorkspace } from '../../lang/test/workspace.js';
import { pendingChanges } from '../src/index.js';

const MODEL = `module shop {
  entity Item {
    sku: String
    price: Money
  }

  migration since_v1_0_0 {
    rename Item.code -> ref
    rename Item.ref -> sku
    retype Item.price: Decimal -> Money
    remove Item.legacy
  }
}`;

test('pending changes know where each element lives now and skip applied steps', async () => {
    const { documents, services } = await buildWorkspace({ 'shop.appling': MODEL });
    const graph = buildGraph(documents.map(d => d.parseResult.value as Model), services);
    const changes = pendingChanges(graph, ['shop.since_v1_0_0#0'], '20261023000000');
    expect(changes.map(c => [c.id, c.kind, c.target, c.current, c.parent])).toEqual([
        ['shop.since_v1_0_0#1', 'rename', 'shop.Item.ref', 'shop.Item.sku', 'shop.Item'],
        ['shop.since_v1_0_0#2', 'retype', 'shop.Item.price', 'shop.Item.price', 'shop.Item'],
        ['shop.since_v1_0_0#3', 'remove', 'shop.Item.legacy', undefined, 'shop.Item']
    ]);
    expect(changes[1].newType).toEqual({ $type: 'TypeRef', primitive: 'Money' });
});

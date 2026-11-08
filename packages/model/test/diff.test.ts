import { expect, test } from 'vitest';
import type { Model } from '@appling/lang';
import { buildWorkspace } from '../../lang/test/workspace.js';
import { buildGraph, diffGraphs, withRemoved, type Graph } from '../src/index.js';

async function graphOf(source: string): Promise<Graph> {
    const { documents, services } = await buildWorkspace({ 'm.appling': source });
    return buildGraph(documents.map(doc => doc.parseResult.value as Model), services);
}

const BEFORE = `module shop {
  enum Status { open closed }
  entity Order {
    status: Status
    total: Decimal
    note: String
  }
  entity Customer {
    name: String
  }
  action Close on Order {
    requires { status == Status.open }
  }
}`;

test('added, changed and removed elements, with the properties and edges that differ', async () => {
    const before = await graphOf(BEFORE);
    const after = await graphOf(`module shop {
  enum Status { open closed }
  entity Order {
    status: Status
    total: Integer
    note: String
    paid: Bool
  }
  action Close on Order {
    requires { status == Status.closed }
  }
}`);
    const diff = diffGraphs(before, after);
    expect(diff.added).toEqual(['shop.Order.paid']);
    expect(diff.removed).toEqual(['shop.Customer', 'shop.Customer.name']);
    expect(diff.changed).toContain('shop.Order.total');
    expect(diff.changed).toContain('shop.Close');
    expect(diff.changed).not.toContain('shop.Order');
    expect(diff.changed).not.toContain('shop.Order.note');
    expect(diff.changes.find(c => c.qn === 'shop.Order.total')!.props).toEqual(['type']);
    const close = diff.changes.find(c => c.qn === 'shop.Close')!;
    expect(close.edges.added).toEqual([{ from: 'shop.Close', to: 'shop.Status.closed', kind: 'uses' }]);
    expect(close.edges.removed).toEqual([{ from: 'shop.Close', to: 'shop.Status.open', kind: 'uses' }]);
    expect(diffGraphs(before, before).changes).toEqual([]);
});

test('a rename that a new migration step records is one change, with its members following', async () => {
    const before = await graphOf(BEFORE);
    const after = await graphOf(`module shop {
  enum Status { open closed }
  entity Purchase {
    status: Status
    total: Decimal
    remark: String
  }
  entity Customer {
    name: String
  }
  action Close on Purchase {
    requires { status == Status.open }
  }
  migration since_v1_0_0 {
    rename Order -> Purchase
    rename Purchase.note -> remark
  }
}`);
    const diff = diffGraphs(before, after);
    expect(diff.renamed).toEqual({ 'shop.Purchase': 'shop.Order', 'shop.Purchase.status': 'shop.Order.status', 'shop.Purchase.total': 'shop.Order.total', 'shop.Purchase.remark': 'shop.Order.note' });
    expect(diff.removed).toEqual([]);
    expect(diff.added).toEqual(['shop.since_v1_0_0']);
    expect(diff.changes.find(c => c.qn === 'shop.Purchase')).toMatchObject({ status: 'changed', was: 'shop.Order', props: [] });
    // the action names its entity by the new name, which is the same element
    expect(diff.changed).not.toContain('shop.Close');
});

test('without a migration step a rename is a removal and an addition', async () => {
    const diff = diffGraphs(await graphOf(BEFORE), await graphOf(BEFORE.replace('Customer', 'Client')));
    expect(diff.added).toEqual(['shop.Client', 'shop.Client.name']);
    expect(diff.removed).toEqual(['shop.Customer', 'shop.Customer.name']);
});

test('removed elements go back into the graph after, under their parent and with their edges', async () => {
    const before = await graphOf(BEFORE);
    const after = await graphOf(BEFORE.replace(/  action Close[\s\S]*?\n  \}\n/, ''));
    const diff = diffGraphs(before, after);
    expect(diff.removed).toEqual(['shop.Close']);
    const merged = withRemoved(before, after, diff);
    expect(merged.nodes.map(n => n.qn)).toContain('shop.Close');
    expect(merged.edges).toContainEqual({ from: 'shop', to: 'shop.Close', kind: 'contains' });
    expect(merged.edges).toContainEqual({ from: 'shop.Close', to: 'shop.Order', kind: 'entity' });
    expect(withRemoved(before, before, diffGraphs(before, before))).toBe(before);
});

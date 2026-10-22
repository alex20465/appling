import { expect, test } from 'vitest';
import type { Model } from '@appling/lang';
import { buildGraph, dependencies } from '@appling/model';
import { buildWorkspace, examples } from '../../lang/test/workspace.js';
import { elementAt, followRenames, GraphIndex, levelForZoom, shownFor, view } from '../src/client/graph/model.js';

async function examplesIndex() {
    const { documents, services } = await buildWorkspace(examples());
    const graph = buildGraph(documents.map(d => d.parseResult.value as Model), services);
    return { index: new GraphIndex(graph), deps: dependencies(graph) };
}

test('zoom picks the level', () => {
    expect([0.3, 0.8, 1.4].map(levelForZoom)).toEqual(['out', 'medium', 'in']);
});

test('zoomed out shows modules with their use cases and dependencies', async () => {
    const { index, deps } = await examplesIndex();
    const out = view(index, deps, 'out');
    expect(out.cards.map(c => [c.qn, c.rows.map(r => r.text)])).toEqual([['crm', []], ['sales', ['Checkout']]]);
    expect(out.links.map(l => `${l.from}>${l.to} ${l.label}`)).toEqual(['sales>crm 7', 'crm>sales 1']);
});

test('medium zoom shows declarations in module groups with lifted references', async () => {
    const { index, deps } = await examplesIndex();
    const medium = view(index, deps, 'medium');
    expect(medium.groups.map(g => g.qn)).toEqual(['crm', 'sales']);
    expect(medium.cards.find(c => c.qn === 'sales.Order')).toMatchObject({ title: 'entity Order', group: 'sales', rows: [] });
    expect(medium.links).toContainEqual({ id: 'sales.Order>crm.Account', from: 'sales.Order', to: 'crm.Account', label: 'type' });
    expect(medium.links.find(l => l.id === 'sales.OrderFlow>sales.PlaceOrder')?.label).toBe('action');
});

test('zoomed in cards list their members', async () => {
    const { index, deps } = await examplesIndex();
    const order = view(index, deps, 'in').cards.find(c => c.qn === 'sales.Order')!;
    expect(order.rows.map(r => r.text)).toContain('status: OrderStatus state');
    expect(order.rows.map(r => r.text)).toContain('invariant["total never negative"]');
});

test('a selection maps to the card and row shown for it', async () => {
    const { index, deps } = await examplesIndex();
    expect(shownFor('sales.Order.status', view(index, deps, 'in'), index)).toEqual({ card: 'sales.Order', row: 'sales.Order.status' });
    expect(shownFor('sales.Order.status', view(index, deps, 'medium'), index)).toEqual({ card: 'sales.Order', row: undefined });
    expect(shownFor('sales.Order.status', view(index, deps, 'out'), index)).toEqual({ card: 'sales', row: undefined });
});

test('the element at an offset is the innermost one', () => {
    const locations = { m: { uri: 'u', start: 0, end: 100 }, 'm.E': { uri: 'u', start: 10, end: 50 }, 'm.E.f': { uri: 'u', start: 20, end: 30 } };
    expect([5, 15, 25, 60].map(o => elementAt(locations, 'u', o))).toEqual(['m', 'm.E', 'm.E.f', 'm']);
});

test('saved positions follow renames recorded in migrations', async () => {
    const { documents, services } = await buildWorkspace({ 'm.appling': 'module m {\n  entity Item {\n    sku: String\n  }\n  migration since_v1_0_0 {\n    rename Item.code -> sku\n  }\n}\n' });
    const graph = buildGraph(documents.map(d => d.parseResult.value as Model), services);
    expect(followRenames({ positions: { in: { 'm.Item.code': { x: 1, y: 2 } } } }, graph)).toEqual({ positions: { in: { 'm.Item.sku': { x: 1, y: 2 } } } });
});

test('a layer view shows only its declarations and the references among them', async () => {
    const { index, deps } = await examplesIndex();
    const domain = view(index, deps, 'medium', ['domain']);
    expect(domain.cards.map(c => c.qn)).toEqual(['crm.Account', 'sales.OrderStatus', 'sales.Line', 'sales.Order']);
    expect(domain.links.map(l => `${l.id} ${l.label}`).sort()).toEqual(['sales.Order>crm.Account type', 'sales.Order>sales.Line type, uses', 'sales.Order>sales.OrderStatus type, uses']);
    expect(domain.groups.map(g => g.qn)).toEqual(['crm', 'sales']);
    const behavior = view(index, deps, 'medium', ['behavior']);
    expect(behavior.cards.every(c => c.layer === 'behavior')).toBe(true);
    expect(behavior.groups.map(g => g.qn)).toEqual(['sales']);
});

import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startInspectProcess, type InspectProcess } from '@appling/inspect/process';
import type { PanelState } from '@appling/inspect/panels';
import { GraphIndex } from '@appling/viz/views';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { PANEL_TREES, type PanelNode } from '../src/panel-trees.js';

// the trees of a real snapshot: the inspect server's on the examples
let ide: InspectProcess;
let base: PanelState;
let index: GraphIndex;

beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), 'appling-panels-'));
    cpSync(join(import.meta.dirname, '../../../examples'), root, { recursive: true });
    ide = await startInspectProcess(root, { main: join(import.meta.dirname, '../../inspect/out/server/main.js') });
    const snapshot = await (await fetch(`${ide.url}/api/snapshot`)).json();
    base = { snapshot, sessions: [], review: { on: false, rev: 'HEAD', marked: true, revisions: [] } };
    index = new GraphIndex(snapshot.graph);
}, 60000);
afterAll(() => ide?.close());

const labels = (nodes: PanelNode[]) => nodes.map(n => n.label);
const find = (nodes: PanelNode[], label: string): PanelNode | undefined => {
    for (const node of nodes) {
        if (node.label === label) return node;
        const inner = find(node.children ?? [], label);
        if (inner) return inner;
    }
    return undefined;
};
const ids = (nodes: PanelNode[]): string[] => nodes.flatMap(n => [n.id, ...ids(n.children ?? [])]);

test('the inspector shows what an action does, who may trigger it, its properties and relations', () => {
    const tree = PANEL_TREES.inspector({ ...base, selected: 'sales.PlaceOrder' }, index);
    expect(tree[0]).toMatchObject({ label: 'sales.PlaceOrder', run: { type: 'source', qn: 'sales.PlaceOrder' } });
    expect(labels(tree)).toEqual(expect.arrayContaining(['What it does', 'Who may trigger it', 'Properties', 'Used by', 'Uses']));
    expect(find(tree, 'sales.Shopper')?.run).toEqual({ type: 'action', action: { type: 'select', qn: 'sales.Shopper' } });
    expect(new Set(ids(tree)).size).toBe(ids(tree).length);
    expect(PANEL_TREES.inspector(base, index)).toEqual([]);
});

test('the inspector shows a list property line by line, read only', () => {
    const tree = PANEL_TREES.inspector({ ...base, selected: 'sales.PlaceOrder' }, index);
    const list = find(tree, 'Properties')!.children!.find(p => p.children?.length)!;
    expect(list.description).toBe(String(list.children!.length));
    expect(ids(tree.filter(n => n.actions))).toEqual([]);
});

test('changes list every changed file with its elements and its diff', () => {
    const file = { path: 'sales.appling', status: 'modified' as const, before: 'a', after: 'b', elements: ['sales.Order'], sessions: ['s1'], at: new Date().toISOString() };
    const change = { qn: 'sales.Order', kind: 'Entity', status: 'changed' as const, props: ['doc'], edges: { added: [], removed: [] } };
    const state: PanelState = {
        ...base,
        sessions: [{ id: 's1', name: 'Claude Code', label: 'orders', color: '#fff' } as PanelState['sessions'][number]],
        live: { files: [file], diff: { added: [], changed: ['sales.Order'], removed: [], changes: [change] } as never, ghosts: { nodes: [], edges: [] } }
    };
    const tree = PANEL_TREES.changes(state, index);
    expect(labels(tree)).toEqual(['sales.appling']);
    expect(tree[0]).toMatchObject({ run: { type: 'liveDiff', path: 'sales.appling' } });
    expect(tree[0].actions).toBeUndefined();
    expect(tree[0].description).toContain('orders');
    expect(tree[0].children![0].label).toBe('sales.Order');
});

test('the review lists the model changes and files since the revision', () => {
    const change = { qn: 'sales.Order', kind: 'Entity', status: 'changed' as const, props: ['doc'], edges: { added: [], removed: [] } };
    const tree = PANEL_TREES.review({ ...base, review: { ...base.review, on: true, result: { ok: true, commit: 'abcdef1234', diff: { added: [], changed: ['sales.Order'], removed: [], changes: [change] } as never, files: [{ path: 'sales.appling', status: 'modified' }] } } }, index);
    expect(labels(tree)).toEqual(['Model', 'Files']);
    expect(tree[0].children![0].actions?.diff).toEqual({ type: 'action', action: { type: 'textDiff', qn: 'sales.Order' } });
    expect(tree[1].children![0].run).toEqual({ type: 'reviewDiff', path: 'sales.appling', from: undefined });
    expect(labels(PANEL_TREES.review({ ...base, review: { ...base.review, result: { ok: false, error: 'Not a git repository' } } }, index))).toEqual(['Not a git repository']);
});

test('the tasks view lists every open registry task with what it misses; without a stack it is empty', () => {
    const task = { target: 'build/app', qn: 'sales.PlaceOrder', kind: 'Action', status: 'todo' as const, missing: ['the action body'], attempts: 1, notes: ['tried once'] };
    const snapshot = { ...base.snapshot, targets: [{ extension: '@appling/codegen-django', out: 'build/app', generated: true }], tasks: [task] };
    const tree = PANEL_TREES.tasks({ ...base, snapshot }, index);
    expect(tree[0]).toMatchObject({ label: 'sales.PlaceOrder', description: 'todo · 1 attempt', run: { type: 'action', action: { type: 'select', qn: 'sales.PlaceOrder' } } });
    expect(labels(tree[0].children!)).toEqual(['the action body', 'tried once']);
    expect(PANEL_TREES.tasks(base, index)).toEqual([]);
    // the inspector lists the element's tasks
    const inspector = PANEL_TREES.inspector({ ...base, snapshot: { ...snapshot, implementation: { 'sales.PlaceOrder': { state: 'partial', tasks: 1 } } } as never, selected: 'sales.PlaceOrder' }, index);
    expect(find(inspector, 'the action body')).toBeDefined();
    expect(inspector.find(n => n.id === 'implementation')?.actions).toBeUndefined();
});

test('code shows the implementation and the targets', () => {
    const tree = PANEL_TREES.code(base, index);
    expect(labels(tree)).toEqual(expect.arrayContaining(['Implementation', 'No targets']));
});

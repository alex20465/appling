import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startIdeProcess, type IdeProcess } from '@appling/ide/process';
import type { PanelState } from '@appling/ide/panels';
import { GraphIndex } from '@appling/viz/views';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { PANEL_TREES, type PanelNode } from '../src/panel-trees.js';

// the trees of a real snapshot: the IDE server's on the examples
let ide: IdeProcess;
let base: PanelState;
let index: GraphIndex;

beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), 'appling-panels-'));
    cpSync(join(import.meta.dirname, '../../../examples'), root, { recursive: true });
    ide = await startIdeProcess(root, { main: join(import.meta.dirname, '../../ide/out/server/main.js') });
    const snapshot = await (await fetch(`${ide.url}/api/snapshot`)).json();
    base = { snapshot, proposals: [], sessions: [], playing: false, review: { on: false, rev: 'HEAD', marked: true, revisions: [] } };
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

test('the inspector edits a list property line by line', () => {
    const tree = PANEL_TREES.inspector({ ...base, selected: 'sales.PlaceOrder' }, index);
    const list = find(tree, 'Properties')!.children!.find(p => p.children?.length)!;
    expect(list.actions?.add).toMatchObject({ type: 'line', qn: 'sales.PlaceOrder', property: list.label, line: undefined, separator: '\n' });
    expect(list.children![0].actions?.remove).toMatchObject({ line: 0, remove: true });
});

test('changes list proposals and every changed file with its elements, accept and revert', () => {
    const file = { path: 'sales.appling', status: 'modified' as const, before: 'a', after: 'b', elements: ['sales.Order'], sessions: ['s1'], at: new Date().toISOString() };
    const change = { qn: 'sales.Order', kind: 'Entity', status: 'changed' as const, props: ['doc'], edges: { added: [], removed: [] } };
    const state: PanelState = {
        ...base,
        sessions: [{ id: 's1', name: 'Claude Code', label: 'orders', color: '#fff' } as PanelState['sessions'][number]],
        live: { files: [file], diff: { added: [], changed: ['sales.Order'], removed: [], changes: [change] } as never, ghosts: { nodes: [], edges: [] } },
        proposals: [{ id: 'p1', session: 's1', at: '', review: { summary: 'Add a note', hunks: [{ file: 'sales.appling', line: 3, added: ['x'], removed: [] }], graph: { added: ['sales.Note'], changed: [], removed: [] } } as never }]
    };
    const tree = PANEL_TREES.changes(state, index);
    expect(labels(tree)).toEqual(['Proposed changes', 'sales.appling']);
    expect(tree[0].children![0].actions).toMatchObject({ accept: { action: { type: 'decide', id: 'p1', decision: { accepted: true } } }, reject: { type: 'reject', proposal: 'p1' } });
    expect(tree[1]).toMatchObject({ run: { type: 'liveDiff', path: 'sales.appling' }, actions: { revert: { action: { type: 'revert', path: 'sales.appling' } } } });
    expect(tree[1].description).toContain('orders');
    expect(tree[1].children![0].label).toBe('sales.Order');
    // a chapter's diff shows only its session's files
    expect(labels(PANEL_TREES.changes({ ...state, proposals: [], changesOf: 's2' }, index))).toEqual(['Written by ended session']);
});

test('the playbook lists chapters with their steps; a click plays, replay starts over', () => {
    const chapter = { id: 'c1', session: 's1', label: 'orders', color: '#fff', repo: '', title: 'Orders', plan: 'The plan', status: 'open', refs: [], opened: '', seen: 1,
        steps: [{ n: 1, elements: ['sales.Order'], change: 'show', note: 'The order', state: 'done', responses: [] }, { n: 2, elements: [], change: 'add', note: 'Next', state: 'planned', responses: [] }] };
    const tree = PANEL_TREES.playbook({ ...base, playbook: { workspace: 'w', chapters: [chapter], position: { chapter: 'c1', step: 1 } } as never }, index);
    expect(tree[0]).toMatchObject({ label: 'Orders', description: '1/2 · orders', icon: 'circle-filled', run: { action: { type: 'play', position: { chapter: 'c1', step: 1 } } } });
    expect(tree[0].actions?.replay).toEqual({ type: 'action', action: { type: 'play', position: { chapter: 'c1', step: 0 } } });
    expect(tree[0].actions?.session).toBeUndefined();
    expect(tree[0].children![1].run).toEqual({ type: 'action', action: { type: 'play', position: { chapter: 'c1', step: 2 } } });
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
    // the inspector lists the element's tasks and generates it; without a stack it asks for one
    const inspector = PANEL_TREES.inspector({ ...base, snapshot: { ...snapshot, implementation: { 'sales.PlaceOrder': { state: 'partial', tasks: 1 } } } as never, selected: 'sales.PlaceOrder' }, index);
    expect(find(inspector, 'the action body')).toBeDefined();
    const bare = PANEL_TREES.inspector({ ...base, snapshot: { ...base.snapshot, implementation: { 'sales.PlaceOrder': { state: 'unimplemented' } } } as never, selected: 'sales.PlaceOrder' }, index);
    // before the application exists, only it generates, asking for a stack without one
    const implementation = bare.find(n => n.id === 'implementation')!;
    expect(implementation.actions?.generate).toBeUndefined();
    expect(find(implementation.children!, 'Generate the application first')?.run).toEqual({ type: 'stack', selection: { mode: 'all' } });
    expect(inspector.find(n => n.id === 'implementation')?.actions?.generate).toEqual({ type: 'action', action: { type: 'generate', selection: { mode: 'elements', elements: ['sales.PlaceOrder'] } } });
});

test('code shows the implementation, the targets, the run with its log and the registry tasks', () => {
    const tree = PANEL_TREES.code({ ...base, run: { id: 'r1', title: 'Generate everything', selection: { mode: 'all' }, started: '', events: [{ type: 'log', target: 'app', line: 'hello' }] } as never }, index);
    expect(labels(tree)).toEqual(expect.arrayContaining(['Implementation', 'No targets', 'Generate everything']));
    expect(find(tree, 'Log')?.run).toEqual({ type: 'log' });
});


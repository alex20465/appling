import { expect, test } from 'vitest';
import { fingerprint, implementationStates, lineMarks, outstandingElements, rollupState, type Graph, type GraphNode, type ResolvedReference } from '../src/index.js';

const node = (qn: string, kind: string, props: Record<string, unknown> = {}) => ({ qn, kind, layer: 'domain', level: 1, module: 'm', props, data: {} }) as unknown as GraphNode;
const graph: Graph = { nodes: [node('m.A', 'Entity'), node('m.A.a', 'Field', { type: 'Int' }), node('m.B', 'Entity'), node('m.Close', 'Action'), node('m.C', 'Entity')], edges: [] };
const reference = (qn: string, status: ResolvedReference['status']): ResolvedReference => ({ qn, file: 'x.py', start: 1, end: 2, anchor: 'x', status });

test('fingerprints follow kind and properties; elements a target has not generated as they are now are outstanding', () => {
    expect(fingerprint(node('m.A.a', 'Field', { type: 'Int' }))).toBe(fingerprint(graph.nodes[1]));
    expect(fingerprint(node('m.A.a', 'Field', { type: 'Text' }))).not.toBe(fingerprint(graph.nodes[1]));
    const record = { at: '', fingerprints: Object.fromEntries(graph.nodes.map(n => [n.qn, fingerprint(n)])) };
    expect(outstandingElements(graph, [])).toEqual(new Set());
    expect(outstandingElements(graph, [record])).toEqual(new Set());
    expect(outstandingElements(graph, [undefined]).size).toBe(5);
    expect(outstandingElements(graph, [{ at: '', fingerprints: { ...record.fingerprints, 'm.A.a': 'old' } }])).toEqual(new Set(['m.A.a']));
});

test('every element gets a state from its references, its registry tasks and the last generation', () => {
    const states = implementationStates(graph, {
        references: [reference('m.A', 'current'), reference('m.B', 'shifted'), reference('m.Close', 'current'), reference('m.C', 'broken'), reference('m.C', 'current'), reference('m.Gone', 'orphaned')],
        tasks: [
            { qn: 'm.A.a', status: 'generated', missing: [] },
            { qn: 'm.Close', status: 'todo', missing: ['implement'] }
        ],
        outstanding: new Set()
    });
    expect(Object.fromEntries(Object.entries(states).map(([qn, s]) => [qn, s.state]))).toEqual({
        'm.A': 'implemented', 'm.A.a': 'implemented', 'm.B': 'shifted', 'm.Close': 'partial', 'm.C': 'broken'
    });
    expect(states['m.Close']).toMatchObject({ references: 1, tasks: 1 });
    // changed since the generation: its generated code no longer counts
    expect(implementationStates(graph, { references: [], tasks: [{ qn: 'm.A.a', status: 'generated', missing: [] }], outstanding: new Set(['m.A.a']) })['m.A.a'])
        .toEqual({ state: 'unimplemented', references: 0, tasks: 0, outstanding: true });
});

test('states roll up and mark the line each element starts on, the innermost one first', () => {
    expect(rollupState([])).toBeUndefined();
    expect(rollupState(['implemented', 'implemented'])).toBe('implemented');
    expect(rollupState(['unimplemented', 'implemented'])).toBe('partial');
    expect(rollupState(['shifted', 'broken', 'implemented'])).toBe('broken');
    const text = 'module m {\n  entity A { a: Int }\n  entity B {\n  }\n}\n';
    const at = (part: string) => text.indexOf(part);
    const marks = lineMarks(
        { m: { uri: 'f', start: 0, end: text.length }, 'm.A': { uri: 'f', start: at('entity A'), end: at(' }\n  entity B') + 2 }, 'm.A.a': { uri: 'f', start: at('a: Int'), end: at('a: Int') + 6 }, 'm.B': { uri: 'f', start: at('entity B'), end: at('}\n}') + 1 }, 'm.X': { uri: 'gone', start: 0, end: 1 } },
        { f: text },
        {
            m: { state: 'partial', references: 0, tasks: 0, outstanding: false },
            'm.A': { state: 'implemented', references: 1, tasks: 0, outstanding: false },
            'm.A.a': { state: 'unimplemented', references: 0, tasks: 0, outstanding: true },
            'm.B': { state: 'broken', references: 0, tasks: 0, outstanding: false },
            'm.X': { state: 'implemented', references: 0, tasks: 0, outstanding: false }
        }
    );
    expect(marks).toEqual({ f: [
        { line: 1, qn: 'm', state: 'partial', outstanding: false },
        { line: 2, qn: 'm.A.a', state: 'unimplemented', outstanding: true },
        { line: 3, qn: 'm.B', state: 'broken', outstanding: false }
    ] });
});

import { expect, test } from 'vitest';
import { codeLenses, codeOf, elementAt, hoverText, markerAt, markIcon, marksByState, modelLenses, modelOf, type ImplementationState } from '../src/implementation.js';

const STATE: ImplementationState = {
    marks: {
        '/r/sales.appling': [
            { line: 3, qn: 'sales.Order', state: 'implemented', outstanding: false },
            { line: 4, qn: 'sales.Order.note', state: 'unimplemented', outstanding: true }
        ]
    },
    links: {
        '/r/out/models.py': [{ qn: 'sales.Order', start: 4, end: 9 }],
        '/r/out/admin.py': [{ qn: 'sales.Order', start: 1, end: 2 }]
    }
};

test('model lines get gutter marks by state, with a hover', () => {
    const marks = marksByState(STATE, '/r/sales.appling');
    expect(marks.implemented.map(m => m.line)).toEqual([3]);
    expect(marks.unimplemented.map(m => m.line)).toEqual([4]);
    expect(marks.partial).toEqual([]);
    expect(marksByState(undefined, '/r/sales.appling').implemented).toEqual([]);
    expect(hoverText(STATE.marks['/r/sales.appling'][1])).toBe('**sales.Order.note**: not implemented, changed since the last generation');
    expect(decodeURIComponent(markIcon('partial'))).toContain('fill="#d98a1c"');
    expect(decodeURIComponent(markIcon('unimplemented'))).toContain('stroke-dasharray');
});

test('code links back to its element; model lines with code link to it', () => {
    expect(codeLenses(STATE, '/r/out/models.py')).toEqual([{ line: 4, qn: 'sales.Order', title: 'Appling: sales.Order' }]);
    expect(codeOf(STATE, 'sales.Order')).toEqual([{ path: '/r/out/models.py', start: 4, end: 9 }, { path: '/r/out/admin.py', start: 1, end: 2 }]);
    expect(modelLenses(STATE, '/r/sales.appling')).toEqual([{ line: 3, qn: 'sales.Order', title: 'Open code (2)' }]);
});

test('go to implementation finds the element of a model line, go to definition the model line of a marker', () => {
    expect(elementAt(STATE, '/r/sales.appling', 3)).toBe('sales.Order');
    // a line inside an element belongs to the nearest declaration above it
    expect(elementAt(STATE, '/r/sales.appling', 9)).toBe('sales.Order.note');
    expect(elementAt(STATE, '/r/sales.appling', 1)).toBeUndefined();
    expect(modelOf(STATE, 'sales.Order.note')).toEqual({ path: '/r/sales.appling', line: 4 });
    expect(modelOf(STATE, 'sales.Gone')).toBeUndefined();
    const line = '    # @appling sales.Order 3fa9c1d2';
    expect(markerAt(line, line.indexOf('Order'))).toEqual({ qn: 'sales.Order', start: 15, end: 26 });
    expect(markerAt(line, line.indexOf('3fa9'))).toBeUndefined();
    expect(markerAt('class Order:', 3)).toBeUndefined();
});

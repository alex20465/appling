import { expect, test } from 'vitest';
import { codeLenses, codeOf, hoverText, markIcon, marksByState, modelLenses, type ImplementationState } from '../src/implementation.js';

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
    expect(marks.broken).toEqual([]);
    expect(marksByState(undefined, '/r/sales.appling').implemented).toEqual([]);
    expect(hoverText(STATE.marks['/r/sales.appling'][1])).toBe('**sales.Order.note**: not implemented, changed since the last generation');
    expect(decodeURIComponent(markIcon('broken'))).toContain('fill="#e5534b"');
    expect(decodeURIComponent(markIcon('unimplemented'))).toContain('stroke-dasharray');
});

test('code links back to its element; model lines with code link to it', () => {
    expect(codeLenses(STATE, '/r/out/models.py')).toEqual([{ line: 4, qn: 'sales.Order', title: 'Appling: sales.Order' }]);
    expect(codeOf(STATE, 'sales.Order')).toEqual([{ path: '/r/out/models.py', start: 4, end: 9 }, { path: '/r/out/admin.py', start: 1, end: 2 }]);
    expect(modelLenses(STATE, '/r/sales.appling')).toEqual([{ line: 3, qn: 'sales.Order', title: 'Open code (2)' }]);
});

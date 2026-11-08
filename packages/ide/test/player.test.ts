import { expect, test } from 'vitest';
import type { Chapter, Playbook, PlaybookStep } from '@appling/ai';
import { back, canForward, forward, queued, stepView, unwatchedCounts } from '../src/shared/player.js';

function step(n: number, change: PlaybookStep['change'], elements: string[], state: PlaybookStep['state'] = 'planned'): PlaybookStep {
    return { n, change, elements, note: `step ${n}`, state, responses: [] };
}

function chapter(id: string, steps: PlaybookStep[], extra: Partial<Chapter> = {}): Chapter {
    return { id, label: id, color: '#000', repo: '/r', title: id, plan: `plan ${id}`, steps, status: 'open', refs: [], opened: '', ...extra };
}

const book: Playbook = {
    workspace: 'w',
    position: { step: 0 },
    chapters: [
        chapter('a', [step(1, 'add', ['sales.Invoice'], 'done'), step(2, 'change', ['sales.Order'])], { seen: 2, session: 's1' }),
        chapter('b', [step(1, 'remove', ['sales.Legacy']), step(2, 'show', ['sales.Invoice', 'sales.pay'])], { refs: ['a'], session: 's2' }),
        chapter('c', [], { session: 's2' })
    ]
};

test('stepping forward and back runs through the chapters in order, starting at the first unwatched one', () => {
    expect(forward(book, { step: 0 })).toEqual({ chapter: 'b', step: 0 });
    expect(forward(book, { chapter: 'a', step: 1 })).toEqual({ chapter: 'a', step: 2 });
    expect(forward(book, { chapter: 'a', step: 2 })).toEqual({ chapter: 'b', step: 0 });
    expect(forward(book, { chapter: 'c', step: 0 })).toEqual({ chapter: 'c', step: 0 });
    expect(canForward(book, { chapter: 'c', step: 0 })).toBe(false);
    expect(back(book, { chapter: 'b', step: 0 })).toEqual({ chapter: 'a', step: 2 });
    expect(back(book, { chapter: 'b', step: 2 })).toEqual({ chapter: 'b', step: 1 });
    expect(back(book, { chapter: 'a', step: 0 })).toEqual({ chapter: 'a', step: 0 });
});

test('what queues after the watched chapter, and the unwatched counts per session', () => {
    expect(queued(book, { chapter: 'a', step: 1 }).map(c => c.id)).toEqual(['b', 'c']);
    expect(queued(book, { chapter: 'b', step: 1 }).map(c => c.id)).toEqual(['c']);
    expect(unwatchedCounts(book)).toEqual({ total: 2, sessions: { s2: 2 } });
});

test('a step draws the trail so far, the chapters it builds on first, and marks its own elements', () => {
    expect(stepView(book, { chapter: 'a', step: 1 })).toMatchObject({ at: 1, focus: ['sales.Invoice'], changes: { added: ['sales.Invoice'], planned: false } });
    expect(stepView(book, { chapter: 'a', step: 2 })).toMatchObject({ focus: ['sales.Invoice', 'sales.Order'], changes: { changed: ['sales.Order'], planned: true } });
    // the plan of a chapter shows what it builds on
    expect(stepView(book, { chapter: 'b', step: 0 })).toMatchObject({ at: 0, focus: ['sales.Invoice', 'sales.Order'], changes: { added: [], changed: [], removed: [] } });
    expect(stepView(book, { chapter: 'b', step: 1 })).toMatchObject({ focus: ['sales.Invoice', 'sales.Order', 'sales.Legacy'], changes: { removed: ['sales.Legacy'] } });
    expect(stepView(book, { chapter: 'b', step: 2 })!.focus).toEqual(['sales.Order', 'sales.Legacy', 'sales.Invoice', 'sales.pay']);
    expect(stepView(book, { step: 0 })).toBeUndefined();
});

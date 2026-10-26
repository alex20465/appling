import { expect, test } from 'vitest';
import type { Model } from '@appling/lang';
import { buildWorkspace } from '../../lang/test/workspace.js';
import { buildGraph, relevance, relevanceLevel } from '../src/index.js';

async function relevanceOf(source: string) {
    const { documents, services } = await buildWorkspace({ 'm.appling': source });
    return relevance(buildGraph(documents.map(doc => doc.parseResult.value as Model), services));
}

test('what many declarations use scores high, what one uses scores low, and a module scores as its best', async () => {
    const scores = await relevanceOf(`module m {
        enum Kind { a b }
        event Placed { }
        entity Order { kind: Kind }
        action Place on Order { effect { emit Placed } }
        action Cancel on Order { }
        query Open from Order { }
    }`);
    expect(scores.get('m.Order')).toBe(1);
    expect(scores.get('m.Kind')).toBeLessThan(scores.get('m.Place')!);
    expect(scores.get('m')).toBe(1);
});

test('a declared level maps the score into its range, and a module passes its level to its members', async () => {
    const scores = await relevanceOf(`module m {
        enum Kind core { a b }
        entity Order { kind: Kind }
        action Place on Order { }
        module logs peripheral {
            entity Line { order: m.Order }
            action Write on Line supporting { }
        }
    }`);
    expect(relevanceLevel(scores.get('m.Kind')!)).toBe('core');
    expect(relevanceLevel(scores.get('m.logs.Line')!)).toBe('peripheral');
    expect(relevanceLevel(scores.get('m.logs.Write')!)).toBe('supporting');
    expect(relevanceLevel(scores.get('m.logs')!)).toBe('supporting');
});

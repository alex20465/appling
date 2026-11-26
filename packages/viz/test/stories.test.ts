import { expect, test } from 'vitest';
import type { Model } from '@appling/lang';
import { buildGraph } from '@appling/model';
import { buildWorkspace, examples } from '../../lang/test/workspace.js';
import { STORIES } from '../src/stories.js';
import { DEFAULT_VIEW, flowView, GraphIndex, lensOf, screenFlow, trailOf, useCaseDiagram } from '../src/views.js';

// The landing site draws these stories: each must still find its element in examples/ and have something to show
test.each(STORIES)('story $id draws $element', async ({ view, element }) => {
    const { documents, services } = await buildWorkspace(examples());
    const index = new GraphIndex(buildGraph(documents.map(d => d.parseResult.value as Model), services));
    expect(index.nodes.has(element)).toBe(true);
    if (view === 'levels') expect(trailOf(index, { ...DEFAULT_VIEW, lens: lensOf(index.nodes.get(element)!.kind)! }, [element]).ids[0]).toBeDefined();
    if (view === 'states') expect(flowView(index, 'machine', [element]).nodes.length).toBeGreaterThan(1);
    if (view === 'usecases') expect(useCaseDiagram(index).associations.some(a => a.actor === element)).toBe(true);
    if (view === 'screens') expect(screenFlow(index, element).screens.length).toBeGreaterThan(0);
});

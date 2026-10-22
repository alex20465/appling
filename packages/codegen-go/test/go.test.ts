import { expect, test } from 'vitest';
import type { Model } from '@appling/lang';
import { plan } from '@appling/codegen';
import { buildGraph } from '@appling/model';
import { buildWorkspace, examples } from '../../lang/test/workspace.js';
import go from '../src/index.js';

test('examples generate Go packages for the domain and behavior layers', async () => {
    const { documents, services } = await buildWorkspace(examples());
    const result = plan(buildGraph(documents.map(d => d.parseResult.value as Model), services), go, 'shop');
    const files = new Map<string, string>();
    for (const { step } of result.steps) if (step.kind === 'template') files.set(step.file, step.write(files.get(step.file)));
    expect(Object.fromEntries(files)).toMatchSnapshot();
    const entries = Object.fromEntries(result.entries.map(e => [e.qn, e]));
    expect(entries['sales.PlaceOrder'].status).toBe('partial');
    expect(entries['sales.OpenOrders'].status).toBe('todo');
    expect(entries['sales.Order.total'].status).toBe('generated');
});

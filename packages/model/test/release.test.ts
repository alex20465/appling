import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { buildSources, print, type Model } from '@appling/lang';
import { uriOf } from '../../lang/test/workspace.js';
import { applyEdit, buildGraph, latestRelease, migrationBlockName, readReleases, writeRelease, type EditOperation, type Release } from '../src/index.js';

const URI = uriOf('shop.appling');
const SHOP = `module shop {
  entity Item {
    code: String
    price: Decimal
  }

  action Buy on Item {
  }
}
`;

async function release(text: string, version = '1.0.0'): Promise<Release> {
    const { documents, services } = await buildSources({ [URI]: text });
    return { version, created: '', graph: buildGraph(documents.map(d => d.parseResult.value as Model), services) };
}

async function edit(text: string, operation: EditOperation, released: Release): Promise<string> {
    const result = await applyEdit({ [URI]: text }, operation, { release: released });
    if (!result.ok) throw new Error(result.errors.join('\n'));
    const { documents } = await buildSources(result.sources);
    expect(print(documents[0].parseResult.value)).toBe(result.sources[URI]);
    return result.sources[URI];
}

test('releases are written once and the latest is found by version', async () => {
    const root = mkdtempSync(join(tmpdir(), 'appling-'));
    const { graph } = await release(SHOP);
    writeRelease(root, '1.2.0', graph);
    writeRelease(root, '1.10.0', graph);
    expect(() => writeRelease(root, '1.2.0', graph)).toThrow('Release 1.2.0 already exists.');
    expect(() => writeRelease(root, 'v2', graph)).toThrow('Version must look like 1.2.3, got "v2".');
    expect(latestRelease(readReleases(root))?.version).toBe('1.10.0');
    expect(migrationBlockName('1.10.0')).toBe('since_v1_10_0');
});

test('editing a released L1 element appends migration steps', async () => {
    const released = await release(SHOP);
    const renamed = await edit(SHOP, { op: 'rename', target: 'shop.Item.code', name: 'sku' }, released);
    expect(renamed).toContain('  migration since_v1_0_0 {\n    rename Item.code -> sku\n  }\n}\n');
    const twice = await edit(renamed, { op: 'rename', target: 'shop.Item.sku', name: 'ref' }, released);
    expect(twice).toContain('    rename Item.code -> sku\n    rename Item.sku -> ref\n');
    const retyped = await edit(twice, { op: 'retype', target: 'shop.Item.price', type: 'Money' }, released);
    expect(retyped).toContain('    retype Item.price: Decimal -> Money\n');
    const removed = await edit(retyped, { op: 'remove', target: 'shop.Item.ref' }, released);
    expect(removed).toContain('    remove Item.ref\n  }');
});

test('elements added after the release and other layers get no steps', async () => {
    const released = await release(SHOP);
    const added = await edit(SHOP.replace('price: Decimal', 'price: Decimal\n    note: Text'), { op: 'rename', target: 'shop.Item.note', name: 'remark' }, released);
    expect(added).not.toContain('migration');
    expect(await edit(SHOP, { op: 'rename', target: 'shop.Buy', name: 'Purchase' }, released)).not.toContain('migration');
});

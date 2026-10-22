import { expect, test } from 'vitest';
import { print } from '../src/index.js';
import { build, errors, examples } from './workspace.js';

test('examples check without errors', async () => {
    expect(errors(await build(examples()))).toEqual([]);
});

test('fmt is idempotent on examples', async () => {
    const once = (await build(examples())).map(doc => print(doc.parseResult.value));
    const twice = (await build(Object.fromEntries(once.map((text, i) => [`${i}.appling`, text])))).map(doc => print(doc.parseResult.value));
    expect(twice).toEqual(once);
});

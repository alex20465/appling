import { expect, test } from 'vitest';
import { print, type Entity, type Model } from '../src/index.js';
import { build, errors, examples } from './workspace.js';

test('examples check without errors', async () => {
    expect(errors(await build(examples()))).toEqual([]);
});

test('fmt is idempotent on examples', async () => {
    const once = (await build(examples())).map(doc => print(doc.parseResult.value));
    const twice = (await build(Object.fromEntries(once.map((text, i) => [`${i}.appling`, text])))).map(doc => print(doc.parseResult.value));
    expect(twice).toEqual(once);
});

test('link marks a secondary entity and stays a valid name', async () => {
    const text = 'module m {\n  entity Tag {\n    link: String\n  }\n\n  entity link OrderTag {\n    tag: Tag\n  }\n\n  entity link {\n    name: String\n  }\n}\n';
    const [doc] = await build({ 'm.appling': text });
    expect(errors([doc])).toEqual([]);
    expect(print(doc.parseResult.value)).toBe(text);
    const [tag, orderTag, named] = (doc.parseResult.value as Model).modules[0].members as Entity[];
    expect([tag.link, orderTag.link, named.link, named.name]).toEqual([false, true, false, 'link']);
});

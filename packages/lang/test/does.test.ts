import { expect, test } from 'vitest';
import { AstUtils } from 'langium';
import { doesNames, print, textBlockValue, type Entity, type Model } from '../src/index.js';
import { build, errors } from './workspace.js';

test('a text block keeps its lines without the common indentation', () => {
    expect(textBlockValue('"""\n      First line.\n        Indented.\n\n      Last.\n    """')).toBe('First line.\n  Indented.\n\nLast.');
    expect(textBlockValue('"""One line"""')).toBe('One line');
});

test('does parses in both forms on declarations, fields and operations, and stays a valid name', async () => {
    const text = [
        'module m does "The module" {',
        '  entity Account does """',
        '        Someone who buys.',
        '          Indented.',
        '      """ {',
        '    email: String unique does "Login, like a@b.com"',
        '    does: String',
        '  }',
        '  external Clerk { op BanUser(id: String) does "Bans an @Account" }',
        '}'
    ].join('\n');
    const [doc] = await build({ 'm.appling': text });
    expect(errors([doc])).toEqual([]);
    const model = doc.parseResult.value as Model;
    const account = model.modules[0].members[0] as Entity;
    expect(model.modules[0].does).toBe('The module');
    expect(account.does).toBe('Someone who buys.\n  Indented.');
    expect(account.fields.map(f => [f.name, f.does])).toEqual([['email', 'Login, like a@b.com'], ['does', undefined]]);
    const op = AstUtils.streamAst(model).find(n => n.$type === 'ExternalOperation')!;
    expect(doesNames(op).map(n => [n.name, text.slice(n.offset, n.end)])).toEqual([['Account', 'Account']]);
    expect(doesNames(account.fields[0])).toEqual([]);
});

test('fmt re-indents a text block with its block and is idempotent', async () => {
    const [doc] = await build({ 'm.appling': 'module m { entity A does """\n      Line one.\n        Two.\n   """ { x: Int does "x" } }' });
    const once = print(doc.parseResult.value);
    expect(once).toBe('module m {\n  entity A does """\n    Line one.\n      Two.\n  """ {\n    x: Int does "x"\n  }\n}\n');
    const [again] = await build({ 'm.appling': once });
    expect(print(again.parseResult.value)).toBe(once);
});

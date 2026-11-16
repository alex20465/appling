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
        'module m describe "The module" {',
        '  entity Account describe """',
        '        Someone who buys.',
        '          Indented.',
        '      """ {',
        '    email: String unique describe "Login, like a@b.com"',
        '    does: String',
        '  }',
        '  external Clerk { op BanUser(id: String) describe "Bans an @Account" }',
        '}'
    ].join('\n');
    const [doc] = await build({ 'm.appling': text });
    expect(errors([doc])).toEqual([]);
    const model = doc.parseResult.value as Model;
    const account = model.modules[0].members[0] as Entity;
    expect(model.modules[0].describe).toBe('The module');
    expect(account.describe).toBe('Someone who buys.\n  Indented.');
    expect(account.fields.map(f => [f.name, f.describe])).toEqual([['email', 'Login, like a@b.com'], ['does', undefined]]);
    const op = AstUtils.streamAst(model).find(n => n.$type === 'ExternalOperation')!;
    expect(doesNames(op).map(n => [n.name, text.slice(n.offset, n.end)])).toEqual([['Account', 'Account']]);
    expect(doesNames(account.fields[0])).toEqual([]);
});

test('fmt re-indents a text block with its block and is idempotent', async () => {
    const [doc] = await build({ 'm.appling': 'module m { entity A describe """\n      Line one.\n        Two.\n   """ { x: Int describe "x" } }' });
    const once = print(doc.parseResult.value);
    expect(once).toBe('module m {\n  entity A describe """\n    Line one.\n      Two.\n  """ {\n    x: Int describe "x"\n  }\n}\n');
    const [again] = await build({ 'm.appling': once });
    expect(print(again.parseResult.value)).toBe(once);
});

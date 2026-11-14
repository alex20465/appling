import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { findMarkers, largestDeclaration, writeMarker } from '../src/index.js';

const ranges = async (text: string, extension: string) => (await findMarkers(text, extension)).map(m => [m.qn, m.line, m.start, m.end, m.fingerprint]);

test('a Python marker comment marks the next declaration, a docstring marker its definition', async () => {
    const text = [
        '# @appling sales.Order 0000000a',
        'class Order(models.Model):',
        '    # @appling sales.Order.status',
        '    status = models.CharField()',
        '    total = models.DecimalField()',
        '',
        '',
        '# @appling sales.Close',
        '@decorator',
        'def close():',
        '    """Closes an order.',
        '',
        '    @appling sales.Order.close 0000000b',
        '    """',
        '    return 1',
        ''
    ].join('\n');
    expect(await ranges(text, '.py')).toEqual([
        ['sales.Order', 1, 2, 5, '0000000a'],
        ['sales.Order.status', 3, 4, 4, undefined],
        ['sales.Close', 8, 9, 15, undefined],
        ['sales.Order.close', 13, 10, 15, '0000000b']
    ]);
});

test('Elixir markers: a module doc marks the module, a function doc the function, a comment the DSL block after it', async () => {
    const text = [
        'defmodule Shop.Order do',
        '  @moduledoc """',
        '  @appling sales.Order',
        '  """',
        '  @doc """',
        '  @appling sales.Total',
        '  """',
        '  def total, do: 1',
        '  # @appling sales.Place',
        '  create :place do',
        '    accept [:total]',
        '  end',
        'end',
        ''
    ].join('\n');
    expect(await ranges(text, '.ex')).toEqual([['sales.Order', 3, 1, 13, undefined], ['sales.Total', 6, 8, 8, undefined], ['sales.Place', 9, 10, 12, undefined]]);
});

test('markers in doc comments of other languages; marker text in code or other files is none', async () => {
    expect(await ranges('package shop\n\n// Place places.\n// @appling sales.Place\nfunc Place() {\n}\n', '.go')).toEqual([['sales.Place', 4, 5, 6, undefined]]);
    expect(await ranges('/// Places.\n// @appling sales.Place\nfn place() {\n}\n', '.rs')).toEqual([['sales.Place', 2, 3, 4, undefined]]);
    expect(await ranges('const MARKER = `\n@appling\n`;\n/** @appling sales.Place */\nexport function place() {\n  return 1;\n}\n', '.ts')).toEqual([['sales.Place', 4, 5, 7, undefined]]);
    expect(await ranges('@appling sales.Place\n', '.md')).toEqual([]);
});

test('without a grammar the range is the code line after the marker and what is indented below it', async () => {
    expect(await ranges('# @appling sales.Order\norder:\n  total: 1\n\n  state: open\nother: 2\n', '.yaml')).toEqual([['sales.Order', 1, 2, 5, undefined]]);
});

test('a marker is written above a declaration with its indentation, renewed in place, and refused on an empty line', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'appling-')), 'models.py');
    writeFileSync(path, 'class Order:\n    total = 1\n\n    def close(self):\n        pass\n');
    expect(await writeMarker(path, 4, 'sales.Order.close', '0000000a')).toEqual({ start: 5, end: 6 });
    expect(readFileSync(path, 'utf8')).toBe('class Order:\n    total = 1\n\n    # @appling sales.Order.close 0000000a\n    def close(self):\n        pass\n');
    expect(await writeMarker(path, 5, 'sales.Order.close', '0000000b')).toEqual({ start: 5, end: 6 });
    expect(readFileSync(path, 'utf8')).toContain('# @appling sales.Order.close 0000000b\n');
    await expect(writeMarker(path, 3, 'sales.Order', 'x')).rejects.toThrow('Line 3 of models.py is empty');
});

test('generated code is marked at its largest declaration; a marker with nothing after it marks its own line', async () => {
    const text = 'import os\n\ndef helper(x):\n    return x\n\n\ndef orders(request):\n    rows = []\n    return rows\n';
    expect(await largestDeclaration(text, '.py', 1, 9)).toBe(7);
    expect(await largestDeclaration(text, '.yaml', 3, 9)).toBe(3);
    expect(await ranges('GROUPS = [\n    "Clerk",\n    # @appling crm.Clerk\n]\n', '.py')).toEqual([['crm.Clerk', 3, 3, 3, undefined]]);
});

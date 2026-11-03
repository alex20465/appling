import { EmptyFileSystem, URI } from 'langium';
import { expect, test } from 'vitest';
import { createApplingLspServices } from '../src/lsp.js';

const TEXT = `module shop {
  export Status, Item
  enum Status { open done }
  entity Item {
    /** The lifecycle of an item. */
    status: Status state
  }
}
`;

async function open(text: string) {
    const { shared, Appling } = createApplingLspServices(EmptyFileSystem);
    const document = shared.workspace.LangiumDocumentFactory.fromString(text, URI.file('/shop.appling'));
    shared.workspace.LangiumDocuments.addDocument(document);
    await shared.workspace.DocumentBuilder.build([document], { validation: true });
    const at = (needle: string) => ({ textDocument: { uri: document.uri.toString() }, position: document.textDocument.positionAt(text.indexOf(needle) + 1) });
    return { Appling, document, at };
}

test('formatting returns the canonical text', async () => {
    const { Appling, document } = await open(TEXT);
    const [edit] = await Appling.lsp.Formatter!.formatDocument(document, { textDocument: { uri: document.uri.toString() }, options: { tabSize: 2, insertSpaces: true } });
    expect(edit.newText).toContain('  enum Status {\n    open\n    done\n  }');
});

test('hover shows kind, qualified name, layer and doc comment', async () => {
    const { Appling, document, at } = await open(TEXT);
    const hover = await Appling.lsp.HoverProvider!.getHoverContent(document, at('status:'));
    expect(hover?.contents).toEqual({ kind: 'markdown', value: 'Field `shop.Item.status`, domain layer\n\nThe lifecycle of an item.' });
});

test('go to definition follows a reference', async () => {
    const { Appling, document, at } = await open(TEXT);
    const [link] = await Appling.lsp.DefinitionProvider!.getDefinition(document, at('Status state')) ?? [];
    expect(document.textDocument.offsetAt(link.targetSelectionRange.start)).toBe(TEXT.indexOf('Status {'));
});

test('rename from the declaration or the export line renames both and every reference', async () => {
    const { Appling, document, at } = await open(TEXT);
    for (const needle of ['Status {', 'Status, Item']) {
        const edit = await Appling.lsp.RenameProvider!.rename(document, { ...at(needle), newName: 'Phase' });
        const texts = edit?.changes?.[document.uri.toString()].map(e => document.textDocument.offsetAt(e.range.start)).sort((a, b) => a - b);
        expect(texts).toEqual([TEXT.indexOf('Status, Item'), TEXT.indexOf('Status {'), TEXT.indexOf('Status state')]);
    }
});

test('export names lead to their member and find its references', async () => {
    const { Appling, document, at } = await open(TEXT);
    const [link] = await Appling.lsp.DefinitionProvider!.getDefinition(document, at('Item\n')) ?? [];
    expect(document.textDocument.offsetAt(link.targetSelectionRange.start)).toBe(TEXT.indexOf('Item {'));
    const references = await Appling.lsp.ReferencesProvider!.findReferences(document, { ...at('Status {'), context: { includeDeclaration: false } });
    expect(references.map(r => document.textDocument.offsetAt(r.range.start)).sort((a, b) => a - b)).toEqual([TEXT.indexOf('Status, Item'), TEXT.indexOf('Status state')]);
});

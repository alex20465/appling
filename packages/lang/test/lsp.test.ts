import { EmptyFileSystem, URI } from 'langium';
import { expect, test } from 'vitest';
import { createApplingLspServices } from '../src/lsp.js';

const TEXT = `module shop {
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

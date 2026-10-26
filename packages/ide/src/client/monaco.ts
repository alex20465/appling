import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import monarch from '@appling/lang/monarch';

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

monaco.languages.register({ id: 'appling', extensions: ['.appling'] });
monaco.languages.setMonarchTokensProvider('appling', monarch as monaco.languages.IMonarchLanguage);
monaco.languages.setLanguageConfiguration('appling', {
    comments: { lineComment: '//', blockComment: ['/*', '*/'] },
    brackets: [['{', '}'], ['[', ']'], ['(', ')']],
    autoClosingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' }, { open: '"', close: '"' }]
});
monaco.editor.defineTheme('appling', {
    base: 'vs-dark',
    inherit: true,
    rules: [
        { token: 'keyword', foreground: 'a6dc5a' },
        { token: 'string', foreground: 'd9d0c3' },
        { token: 'number', foreground: '5cbf63' },
        { token: 'comment', foreground: '7a6e5e', fontStyle: 'italic' },
        { token: 'operator', foreground: 'aaa092' }
    ],
    colors: {
        'editor.background': '#0c0a08',
        'editor.foreground': '#f7f2ea',
        'editorLineNumber.foreground': '#7a6e5e',
        'editor.selectionBackground': '#5cbf6340',
        'editor.lineHighlightBackground': '#14110d'
    }
});

/** The current text of every open Appling file, saved or not. */
export function modelTexts(): Record<string, string> {
    return Object.fromEntries(monaco.editor.getModels().filter(m => m.getLanguageId() === 'appling').map(m => [m.uri.toString(), m.getValue()]));
}

/** Applies offset based edits to the open models as one undoable step per model; returns the changed URIs. */
export function applyTextEdits(edits: { uri: string, offset: number, length: number, text: string }[]): string[] {
    const uris = [...new Set(edits.map(e => e.uri))];
    for (const uri of uris) {
        const model = monaco.editor.getModel(monaco.Uri.parse(uri))!;
        const operations = edits.filter(e => e.uri === uri).map(e => {
            const start = model.getPositionAt(e.offset);
            const end = model.getPositionAt(e.offset + e.length);
            return { range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column), text: e.text };
        });
        model.pushStackElement();
        model.pushEditOperations([], operations, () => null);
        model.pushStackElement();
    }
    return uris;
}

export { monaco };

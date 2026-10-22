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

/** Connects Monaco's own LSP client to the language server; it keeps every open model in sync. */
export async function connectLanguageServer(): Promise<void> {
    const transport = await monaco.lsp.WebSocketTransport.connectTo({ address: `ws://${location.host}/lsp` });
    new monaco.lsp.MonacoLspClient(transport);
}

export { monaco };

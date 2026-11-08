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
/**
 * The editor's theme from the theme tokens of `styles.css` as they are now (a host may override them and pick the light
 * theme), redefined whenever the theme changes (`appling-theme` on window).
 */
function editorTheme(): void {
    const style = getComputedStyle(document.documentElement);
    const token = (name: string) => style.getPropertyValue(`--appling-${name}`).trim();
    const hex = (name: string) => /^#[0-9a-f]{3,8}$/i.test(token(name)) ? token(name) : undefined;
    const colors: Record<string, string | undefined> = {
        'editor.background': hex('surface'),
        'editor.foreground': hex('ink'),
        'editorLineNumber.foreground': hex('line-strong'),
        'editor.lineHighlightBackground': hex('surface-raised'),
        'editor.selectionBackground': hex('leaf') && `${hex('leaf')!.slice(0, 7)}40`
    };
    const rule = (token: string, name: string, fontStyle?: string) => ({ token, foreground: hex(name)?.slice(1, 7), fontStyle });
    monaco.editor.defineTheme('appling', {
        base: document.documentElement.dataset.theme === 'light' ? 'vs' : 'vs-dark',
        inherit: true,
        rules: [rule('keyword', 'sprout'), rule('string', 'ink-soft'), rule('number', 'leaf'), rule('comment', 'line-strong', 'italic'), rule('operator', 'ink-muted')],
        colors: Object.fromEntries(Object.entries(colors).filter((entry): entry is [string, string] => !!entry[1]))
    });
    monaco.editor.setTheme('appling');
}
editorTheme();
addEventListener('appling-theme', editorTheme);

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

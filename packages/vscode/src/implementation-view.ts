import {
    CodeLens, commands, EventEmitter, languages, MarkdownString, Range, Uri, window, workspace,
    type CodeLensProvider, type Disposable, type TextEditor, type TextEditorDecorationType
} from 'vscode';
import { openLines } from './editor.js';
import { codeLenses, codeOf, hoverText, MARK_STATES, markIcon, marksByState, modelLenses, type ImplementationState, type MarkState } from './implementation.js';

/**
 * The implementation state in the editor (thin VS Code glue over `implementation.ts`): gutter marks on the model
 * lines, a CodeLens on implementing code that shows its element on the canvas (`appling.showElement` of
 * the inspector tab) and one on model lines with code that opens it (`appling.openCode`).
 */
export class ImplementationView implements Disposable {
    private state?: ImplementationState;
    private readonly types: Record<MarkState, TextEditorDecorationType>;
    private readonly lensesChanged = new EventEmitter<void>();
    private readonly disposables: Disposable[] = [];

    constructor(private readonly showElement: (qn: string) => boolean) {
        this.types = Object.fromEntries(MARK_STATES.map(s => [s, window.createTextEditorDecorationType({ gutterIconPath: Uri.parse(markIcon(s)), gutterIconSize: 'contain' })])) as Record<MarkState, TextEditorDecorationType>;
        const lenses: CodeLensProvider = {
            onDidChangeCodeLenses: this.lensesChanged.event,
            provideCodeLenses: document => {
                const path = document.uri.fsPath;
                const back = codeLenses(this.state, path).map(l => new CodeLens(new Range(l.line - 1, 0, l.line - 1, 0), { title: l.title, command: 'appling.showElement', arguments: [l.qn] }));
                const forth = modelLenses(this.state, path).map(l => new CodeLens(new Range(l.line - 1, 0, l.line - 1, 0), { title: l.title, command: 'appling.openCode', arguments: [l.qn] }));
                return [...back, ...forth];
            }
        };
        this.disposables.push(
            ...Object.values(this.types),
            this.lensesChanged,
            languages.registerCodeLensProvider({ scheme: 'file' }, lenses),
            window.onDidChangeVisibleTextEditors(editors => editors.forEach(e => this.decorate(e))),
            commands.registerCommand('appling.showElement', (qn: string) => {
                if (!this.showElement(qn)) window.showInformationMessage(`No Appling inspector is running for ${qn}; it cannot be shown on the canvas.`);
            }),
            commands.registerCommand('appling.openCode', async (qn?: string) => {
                const element = qn ?? this.elementAtCursor();
                const code = element ? codeOf(this.state, element) : [];
                if (!element || !code.length) return window.showInformationMessage(element ? `${element} has no code reference.` : 'No element on this line.');
                const target = code.length === 1 ? code[0] : await window.showQuickPick(code.map(c => ({ label: `${workspace.asRelativePath(c.path)}:${c.start}-${c.end}`, ...c })), { placeHolder: `The code of ${element}` });
                if (target) await this.open(target.path, target.start, target.end);
            })
        );
    }

    update(state: ImplementationState): void {
        this.state = state;
        window.visibleTextEditors.forEach(e => this.decorate(e));
        this.lensesChanged.fire();
    }

    open(path: string, start: number, end: number): Promise<void> {
        return openLines(path, start, end);
    }

    private decorate(editor: TextEditor): void {
        if (editor.document.languageId !== 'appling') return;
        const marks = marksByState(this.state, editor.document.uri.fsPath);
        for (const s of MARK_STATES) {
            editor.setDecorations(this.types[s], marks[s].map(m => ({ range: new Range(m.line - 1, 0, m.line - 1, 0), hoverMessage: new MarkdownString(hoverText(m)) })));
        }
    }

    private elementAtCursor(): string | undefined {
        const editor = window.activeTextEditor;
        if (!editor) return undefined;
        const line = editor.selection.active.line + 1;
        return this.state?.marks[editor.document.uri.fsPath]?.filter(m => m.line <= line).at(-1)?.qn;
    }

    dispose(): void {
        this.disposables.forEach(d => d.dispose());
    }
}

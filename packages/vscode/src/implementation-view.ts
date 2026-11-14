import {
    CodeLens, commands, EventEmitter, languages, Location, MarkdownString, Position, Range, Uri, window, workspace,
    type CodeLensProvider, type DefinitionProvider, type Disposable, type ImplementationProvider, type LocationLink, type TextDocument, type TextEditor, type TextEditorDecorationType
} from 'vscode';
import { openLines } from './editor.js';
import {
    codeLenses, codeOf, elementAt, hoverText, MARK_STATES, markerAt, markIcon, marksByState, modelLenses, modelOf, type ImplementationState, type MarkState
} from './implementation.js';

/**
 * The implementation state in the editor (thin VS Code glue over `implementation.ts`): gutter marks on the model
 * lines, a CodeLens on implementing code that shows its element on the canvas (`appling.showElement` of
 * the inspector tab) and one on model lines with code that opens it (`appling.openCode`). Go to Implementation on a
 * model element opens its marked code, Go to Definition on an `@appling` marker in code its element in the model.
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
        const implementations: ImplementationProvider = {
            provideImplementation: async (document, position) => {
                const qn = await this.elementAt(document, position);
                if (!qn) return undefined;
                const own = codeOf(this.state, qn);
                const code = own.length ? own : Object.entries(this.state?.links ?? {}).flatMap(([path, links]) => links
                    .filter(l => l.qn.startsWith(`${qn}.`) || l.qn.startsWith(`${qn}#`)).map(l => ({ path, start: l.start, end: l.end })));
                return code.map(c => new Location(Uri.file(c.path), new Range(c.start - 1, 0, c.end - 1, Number.MAX_SAFE_INTEGER)));
            }
        };
        const definitions: DefinitionProvider = {
            provideDefinition: (document, position): LocationLink[] | undefined => {
                if (document.languageId === 'appling') return undefined;
                const marker = markerAt(document.lineAt(position.line).text, position.character);
                const model = marker && modelOf(this.state, marker.qn.split('#')[0]);
                if (!marker || !model) return undefined;
                const target = new Range(model.line - 1, 0, model.line - 1, 0);
                return [{ originSelectionRange: new Range(position.line, marker.start, position.line, marker.end), targetUri: Uri.file(model.path), targetRange: target }];
            }
        };
        this.disposables.push(
            ...Object.values(this.types),
            this.lensesChanged,
            languages.registerCodeLensProvider({ scheme: 'file' }, lenses),
            languages.registerImplementationProvider({ language: 'appling' }, implementations),
            languages.registerDefinitionProvider({ scheme: 'file' }, definitions),
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
        return editor && elementAt(this.state, editor.document.uri.fsPath, editor.selection.active.line + 1);
    }

    /** The element a name in the model stands for (the language server's definition), else the one declared on its line. */
    private async elementAt(document: TextDocument, position: Position): Promise<string | undefined> {
        const found = await commands.executeCommand<(Location | LocationLink)[]>('vscode.executeDefinitionProvider', document.uri, position) ?? [];
        for (const target of found) {
            const uri = 'targetUri' in target ? target.targetUri : target.uri;
            const range = 'targetUri' in target ? target.targetSelectionRange ?? target.targetRange : target.range;
            const qn = elementAt(this.state, uri.fsPath, range.start.line + 1);
            if (qn) return qn;
        }
        return elementAt(this.state, document.uri.fsPath, position.line + 1);
    }

    dispose(): void {
        this.disposables.forEach(d => d.dispose());
    }
}

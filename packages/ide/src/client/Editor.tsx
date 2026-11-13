import { useEffect, useRef, useState } from 'react';
import type { LineMark } from '@appling/model/implementation';
import { IMPLEMENTATION_LABELS } from '@appling/viz/views';
import type { CodeLocation, SourceFile } from '../shared/snapshot.js';
import { monaco } from './monaco.js';
import { CodeView, type OpenCode } from './CodeView.js';

export interface Reveal {
    uri: string;
    start: number;
    end: number;
}

interface EditorProps {
    files: SourceFile[];
    active?: string;
    reveal?: Reveal;
    onActive(uri: string): void;
    onCursor(uri: string, offset: number): void;
    onSave(path: string, text: string): void;
    /** The uris of the dirty models, after every change of that set (Appling Desktop shows them on the rail). */
    onDirty?(uris: string[]): void;
    /** The implementation mark of each line that declares an element, by file URI, from the files on disk. */
    marks?: Record<string, LineMark[]>;
    /** A click on a gutter mark or a code lens: the element declared on that line. */
    onMark?(qn: string): void;
    /** Where elements are implemented, by qualified name: a line whose element has code gets a code lens to it. */
    references?: Record<string, CodeLocation[]>;
    /** **Go to Implementation** (Ctrl+F12, the context menu) at this place of a model file. */
    onImplementationAt?(uri: string, offset: number): void;
    /** A code file shown read only in place of the model, at a line range. */
    code?: OpenCode;
    onCloseCode?(): void;
}

/** Monaco with one model per file. A model is dirty while its text differs from the file on disk; disk changes replace clean models only. */
export function Editor(props: EditorProps) {
    const host = useRef<HTMLDivElement>(null);
    const editor = useRef<monaco.editor.IStandaloneCodeEditor>(null);
    const latest = useRef(props);
    latest.current = props;
    const disk = useRef(new Map<string, string>());
    const [dirty, setDirty] = useState<Set<string>>(new Set());
    const reported = useRef('[]');
    const refreshDirty = () => {
        const uris = monaco.editor.getModels()
            .filter(m => disk.current.has(m.uri.toString()) && m.getValue() !== disk.current.get(m.uri.toString()))
            .map(m => m.uri.toString()).sort();
        setDirty(new Set(uris));
        if (JSON.stringify(uris) === reported.current) return;
        reported.current = JSON.stringify(uris);
        latest.current.onDirty?.(uris);
    };

    useEffect(() => {
        const instance = monaco.editor.create(host.current!, {
            model: null, theme: 'appling', automaticLayout: true, fontFamily: 'JetBrains Mono', fontSize: 13,
            lineHeight: 21, minimap: { enabled: false }, scrollBeyondLastLine: false, padding: { top: 12 }, glyphMargin: true
        });
        editor.current = instance;
        const gutter = instance.onMouseDown(event => {
            if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
            const model = instance.getModel();
            const line = event.target.position?.lineNumber;
            const decoration = model && line && model.getLineDecorations(line).find(d => d.options.glyphMarginClassName?.includes('gutter-impl'));
            const qn = decoration && marked.current.get(decoration.id);
            if (qn) latest.current.onMark?.(qn);
        });
        const cursor = instance.onDidChangeCursorPosition(event => {
            const model = instance.getModel();
            if (model && event.source !== 'api') latest.current.onCursor(model.uri.toString(), model.getOffsetAt(event.position));
        });
        instance.addAction({
            id: 'appling.goToImplementation', label: 'Go to Implementation', contextMenuGroupId: 'navigation', contextMenuOrder: 1.45,
            keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.F12],
            run: ed => {
                const model = ed.getModel();
                const position = ed.getPosition();
                if (model && position) latest.current.onImplementationAt?.(model.uri.toString(), model.getOffsetAt(position));
            }
        });
        // a lens over every declaring line whose element has code, to jump there
        const open = instance.addCommand(0, (_, qn: string) => latest.current.onMark?.(qn))!;
        const lenses = monaco.languages.registerCodeLensProvider('appling', {
            onDidChange: lensesChanged.current.event,
            provideCodeLenses: model => ({
                lenses: (decorations.current.get(model.uri.toString()) ?? []).flatMap(id => {
                    const qn = marked.current.get(id);
                    const range = model.getDecorationRange(id);
                    const code = qn ? latest.current.references?.[qn] ?? [] : [];
                    if (!qn || !range || !code.length) return [];
                    const first = code[0];
                    const more = code.length > 1 ? ` and ${code.length - 1} more` : '';
                    return [{ range, command: { id: open, title: `${first.status === 'broken' ? 'code missing' : 'code'}: ${first.file}:${first.start}${more}`, tooltip: `Open the code of ${qn}`, arguments: [qn] } }];
                }),
                dispose: () => undefined
            })
        });
        instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
            const model = instance.getModel();
            const file = model && latest.current.files.find(f => f.uri === model.uri.toString());
            if (!model || !file) return;
            latest.current.onSave(file.path, model.getValue());
        });
        return () => {
            cursor.dispose();
            gutter.dispose();
            lenses.dispose();
            instance.dispose();
        };
    }, []);


    useEffect(() => {
        for (const file of props.files) {
            const uri = monaco.Uri.parse(file.uri);
            const existing = monaco.editor.getModel(uri);
            if (!existing) {
                monaco.editor.createModel(file.text, 'appling', uri).onDidChangeContent(refreshDirty);
            } else if (existing.getValue() !== file.text && existing.getValue() === disk.current.get(file.uri)) {
                existing.setValue(file.text);
            }
            disk.current.set(file.uri, file.text);
        }
        refreshDirty();
    }, [props.files]);

    useEffect(() => {
        const model = props.active ? monaco.editor.getModel(monaco.Uri.parse(props.active)) : null;
        if (model && editor.current?.getModel() !== model) editor.current?.setModel(model);
    }, [props.active, props.files]);

    useEffect(() => {
        const model = props.reveal && monaco.editor.getModel(monaco.Uri.parse(props.reveal.uri));
        if (!model || !props.reveal || !editor.current) return;
        if (editor.current.getModel() !== model) editor.current.setModel(model);
        const start = model.getPositionAt(props.reveal.start);
        const end = model.getPositionAt(props.reveal.end);
        editor.current.setSelection(new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column));
        editor.current.revealRangeInCenterIfOutsideViewport(new monaco.Range(start.lineNumber, start.column, start.lineNumber, start.column));
    }, [props.reveal]);

    /** The decoration ids of each model's marks, and the element each decoration stands for. */
    const decorations = useRef(new Map<string, string[]>());
    const marked = useRef(new Map<string, string>());
    const lensesChanged = useRef(new monaco.Emitter<monaco.languages.CodeLensProvider>());
    // Marks are placed from the files on disk, on models that match them; on a dirty model they keep moving with the edits.
    useEffect(() => {
        for (const file of props.files) {
            const model = monaco.editor.getModel(monaco.Uri.parse(file.uri));
            if (!model || model.getValue() !== file.text) continue;
            const marks = props.marks?.[file.uri] ?? [];
            const old = decorations.current.get(file.uri) ?? [];
            old.forEach(id => marked.current.delete(id));
            const ids = model.deltaDecorations(old, marks.map(mark => ({
                range: new monaco.Range(mark.line, 1, mark.line, 1),
                options: {
                    glyphMarginClassName: `gutter-impl impl-${mark.state}${mark.outstanding ? ' outstanding' : ''}`,
                    glyphMarginHoverMessage: { value: `**${mark.qn}**: ${IMPLEMENTATION_LABELS[mark.state]}${mark.outstanding ? ', changed since the last generation' : ''}. Click to open its code.` },
                    stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
                }
            })));
            ids.forEach((id, i) => marked.current.set(id, marks[i].qn));
            decorations.current.set(file.uri, ids);
        }
        lensesChanged.current.fire(undefined as never);
    }, [props.marks, props.files, props.references]);

    return (
        <div className="editor">
            <nav className="tabs" aria-label="Files">
                {props.files.map(f => (
                    <button key={f.uri} className={f.uri === props.active ? 'active' : ''} onClick={() => props.onActive(f.uri)}>
                        {f.path}{dirty.has(f.uri) ? ' •' : ''}
                    </button>
                ))}
            </nav>
            <div className="editor-host" ref={host} hidden={!!props.code} />
            {props.code && <CodeView code={props.code} onClose={() => props.onCloseCode?.()} />}
        </div>
    );
}

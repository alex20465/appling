import { useEffect, useRef, useState } from 'react';
import type { SourceFile } from '../shared/snapshot.js';
import { monaco } from './monaco.js';

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
}

/** Monaco with one model per file. Files on disk replace a model's text only while it has no unsaved changes. */
export function Editor(props: EditorProps) {
    const host = useRef<HTMLDivElement>(null);
    const editor = useRef<monaco.editor.IStandaloneCodeEditor>(null);
    const latest = useRef(props);
    latest.current = props;
    const saved = useRef(new Map<string, number>());
    const [dirty, setDirty] = useState<Set<string>>(new Set());

    useEffect(() => {
        const instance = monaco.editor.create(host.current!, {
            model: null, theme: 'appling', automaticLayout: true, fontFamily: 'JetBrains Mono', fontSize: 13,
            lineHeight: 21, minimap: { enabled: false }, scrollBeyondLastLine: false, padding: { top: 12 }
        });
        editor.current = instance;
        const cursor = instance.onDidChangeCursorPosition(event => {
            const model = instance.getModel();
            if (model && event.source !== 'api') latest.current.onCursor(model.uri.toString(), model.getOffsetAt(event.position));
        });
        instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
            const model = instance.getModel();
            const file = model && latest.current.files.find(f => f.uri === model.uri.toString());
            if (!model || !file) return;
            latest.current.onSave(file.path, model.getValue());
            saved.current.set(file.uri, model.getAlternativeVersionId());
            setDirty(current => new Set([...current].filter(uri => uri !== file.uri)));
        });
        return () => {
            cursor.dispose();
            instance.dispose();
        };
    }, []);

    useEffect(() => {
        for (const file of props.files) {
            const uri = monaco.Uri.parse(file.uri);
            const existing = monaco.editor.getModel(uri);
            if (!existing) {
                const model = monaco.editor.createModel(file.text, 'appling', uri);
                saved.current.set(file.uri, model.getAlternativeVersionId());
                model.onDidChangeContent(() => setDirty(current => {
                    const isDirty = model.getAlternativeVersionId() !== saved.current.get(file.uri);
                    return isDirty === current.has(file.uri) ? current : isDirty ? new Set([...current, file.uri]) : new Set([...current].filter(u => u !== file.uri));
                }));
            } else if (existing.getValue() !== file.text && existing.getAlternativeVersionId() === saved.current.get(file.uri)) {
                existing.setValue(file.text);
                saved.current.set(file.uri, existing.getAlternativeVersionId());
            }
        }
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

    return (
        <div className="editor">
            <nav className="tabs" aria-label="Files">
                {props.files.map(f => (
                    <button key={f.uri} className={f.uri === props.active ? 'active' : ''} onClick={() => props.onActive(f.uri)}>
                        {f.path}{dirty.has(f.uri) ? ' •' : ''}
                    </button>
                ))}
            </nav>
            <div className="editor-host" ref={host} />
        </div>
    );
}

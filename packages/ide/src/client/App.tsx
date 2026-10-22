import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Layout, Level, Position, Snapshot } from '../shared/snapshot.js';
import type { EditOperation } from '@appling/model';
import { loadLayout, loadRelease, loadSnapshot, onSnapshot, requestEdit, saveFile, saveLayout } from './api.js';
import { Editor, type Reveal } from './Editor.js';
import { GraphView } from './graph/GraphView.js';
import { elementAt, followRenames, GraphIndex, moveLayout } from './graph/model.js';
import { Inspector } from './Inspector.js';
import { applyTextEdits, connectLanguageServer, modelTexts, monaco } from './monaco.js';

export function App() {
    const [snapshot, setSnapshot] = useState<Snapshot>();
    const [layout, setLayout] = useState<Layout>({});
    const [selected, setSelected] = useState<string>();
    const [active, setActive] = useState<string>();
    const [reveal, setReveal] = useState<Reveal>();
    const [release, setRelease] = useState<{ version: string } | null>(null);

    useEffect(() => {
        loadSnapshot().then(first => {
            setSnapshot(first);
            setActive(first.files[0]?.uri);
            connectLanguageServer();
        });
        loadLayout().then(setLayout);
        loadRelease().then(setRelease);
        return onSnapshot(setSnapshot);
    }, []);

    const index = useMemo(() => snapshot && new GraphIndex(snapshot.graph), [snapshot]);
    const shownLayout = useMemo(() => snapshot ? followRenames(layout, snapshot.graph) : layout, [layout, snapshot]);

    const selectFromGraph = useCallback((qn: string) => {
        setSelected(qn);
        const location = snapshot?.locations[qn];
        if (location) {
            setActive(location.uri);
            setReveal({ ...location });
        }
    }, [snapshot]);

    const moved = useCallback((level: Level, qn: string, position: Position) => {
        setLayout(current => {
            const next = { ...current, positions: { ...current.positions, [level]: { ...current.positions?.[level], [qn]: position } } };
            saveLayout(next);
            return next;
        });
    }, []);

    /** Applies an edit to the open texts, saves the changed files and keeps selection and layout on the edited element. */
    const edit = useCallback(async (operation: EditOperation): Promise<string[]> => {
        const result = await requestEdit(modelTexts(), operation);
        if (!result.ok) return result.errors;
        for (const uri of applyTextEdits(result.edits)) {
            const file = snapshot?.files.find(f => f.uri === uri);
            if (file) await saveFile(file.path, monaco.editor.getModel(monaco.Uri.parse(uri))!.getValue());
        }
        if (operation.op === 'rename') {
            const renamed = `${operation.target.slice(0, operation.target.lastIndexOf('.') + 1)}${operation.name}`;
            setSelected(renamed);
            setLayout(current => {
                const next = moveLayout(current, [[operation.target, renamed]]);
                saveLayout(next);
                return next;
            });
        }
        if (operation.op === 'remove') setSelected(operation.target.slice(0, operation.target.lastIndexOf('.')) || undefined);
        return [];
    }, [snapshot]);

    if (!snapshot || !index) return <div className="loading">Loading the model</div>;
    const block = release && `since_v${release.version.replaceAll('.', '_')}`;
    const pending = block ? snapshot.graph.nodes.filter(n => n.kind === 'Migration' && n.qn.endsWith(`.${block}`)) : [];
    const steps = pending.reduce((count, m) => count + ((m.props.steps as string[] | undefined)?.length ?? 0), 0);
    return (
        <div className="app">
            <header className="bar">
                <img src="/appling-icon.svg" alt="" width={20} height={20} />
                <strong>Appling</strong>
                <span className="muted">{decodeURIComponent(snapshot.root.replace('file://', ''))}</span>
                {release && (
                    <button className="release" onClick={() => pending[0] && selectFromGraph(pending[0].qn)} disabled={!pending.length}>
                        release {release.version} · {steps} migration step(s) since
                    </button>
                )}
                <span className={snapshot.errors.length ? 'errors' : 'ok'}>{snapshot.errors.length ? `${snapshot.errors.length} error(s)` : 'valid'}</span>
            </header>
            <main className="panes">
                <Editor
                    files={snapshot.files}
                    active={active}
                    reveal={reveal}
                    onActive={setActive}
                    onCursor={(uri, offset) => setSelected(elementAt(snapshot.locations, uri, offset))}
                    onSave={(path, text) => saveFile(path, text)}
                />
                <GraphView index={index} dependencies={snapshot.dependencies} layout={shownLayout} selected={selected} onSelect={selectFromGraph} onMoved={moved} onEdit={edit} />
                <Inspector index={index} qn={selected} onSelect={selectFromGraph} onEdit={edit} />
            </main>
        </div>
    );
}

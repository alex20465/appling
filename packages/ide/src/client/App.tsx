import { useCallback, useEffect, useMemo, useState } from 'react';
import { DEFAULT_VIEW, type Snapshot, type ViewSettings } from '../shared/snapshot.js';
import type { EditOperation } from '@appling/model';
import { loadRelease, loadSnapshot, loadView, onSnapshot, requestEdit, saveFile, saveView } from './api.js';
import { Editor, type Reveal } from './Editor.js';
import { EntityCanvas } from '@appling/viz/canvas';
import { elementAt, GraphIndex } from '@appling/viz/views';
import { Chat } from './Chat.js';
import { Inspector } from './Inspector.js';
import { Search } from './Search.js';
import { applyTextEdits, connectLanguageServer, modelTexts, monaco } from './monaco.js';

export function App() {
    const [snapshot, setSnapshot] = useState<Snapshot>();
    const [selected, setSelected] = useState<string>();
    const [active, setActive] = useState<string>();
    const [reveal, setReveal] = useState<Reveal>();
    const [release, setRelease] = useState<{ version: string } | null>(null);
    const [side, setSide] = useState<'search' | 'inspector' | 'ai'>('search');
    const [view, setView] = useState<ViewSettings>(DEFAULT_VIEW);

    useEffect(() => {
        loadSnapshot().then(first => {
            setSnapshot(first);
            setActive(first.files[0]?.uri);
            connectLanguageServer();
        });
        loadRelease().then(setRelease);
        loadView().then(setView);
        return onSnapshot(setSnapshot);
    }, []);

    const index = useMemo(() => snapshot && new GraphIndex(snapshot.graph), [snapshot]);

    /** Selects an element, reveals its source and, unless asked not to, shows it in the inspector. */
    const select = useCallback((qn: string, inspect = true) => {
        setSelected(qn);
        if (inspect) setSide('inspector');
        const location = snapshot?.locations[qn];
        if (location) {
            setActive(location.uri);
            setReveal({ ...location });
        }
    }, [snapshot]);

    /** Applies an edit to the open texts, saves the changed files and keeps the selection on the edited element. */
    const edit = useCallback(async (operation: EditOperation): Promise<string[]> => {
        const result = await requestEdit(modelTexts(), operation);
        if (!result.ok) return result.errors;
        for (const uri of applyTextEdits(result.edits)) {
            const file = snapshot?.files.find(f => f.uri === uri);
            if (file) await saveFile(file.path, monaco.editor.getModel(monaco.Uri.parse(uri))!.getValue());
        }
        if (operation.op === 'rename') setSelected(`${operation.target.slice(0, operation.target.lastIndexOf('.') + 1)}${operation.name}`);
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
                    <button className="release" onClick={() => pending[0] && select(pending[0].qn)} disabled={!pending.length}>
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
                <EntityCanvas index={index} selected={selected} settings={view} onSelect={select} onSettings={next => { setView(next); saveView(next); }} />
                <div className="side">
                    <nav className="tabs" aria-label="Side panel">
                        <button className={side === 'search' ? 'active' : ''} onClick={() => setSide('search')}>Search</button>
                        <button className={side === 'inspector' ? 'active' : ''} onClick={() => setSide('inspector')}>Inspector</button>
                        <button className={side === 'ai' ? 'active' : ''} onClick={() => setSide('ai')}>AI</button>
                    </nav>
                    <div hidden={side !== 'search'} className="side-panel"><Search index={index} onSelect={select} /></div>
                    <div hidden={side !== 'inspector'} className="side-panel"><Inspector index={index} qn={selected} onSelect={select} onEdit={edit} /></div>
                    <div hidden={side !== 'ai'} className="side-panel"><Chat onEdit={edit} onSelect={qn => select(qn, false)} /></div>
                </div>
            </main>
        </div>
    );
}

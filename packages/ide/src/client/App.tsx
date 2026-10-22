import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Layout, Level, Position, Snapshot } from '../shared/snapshot.js';
import { loadLayout, loadSnapshot, onSnapshot, saveFile, saveLayout } from './api.js';
import { Editor, type Reveal } from './Editor.js';
import { GraphView } from './graph/GraphView.js';
import { elementAt, followRenames, GraphIndex } from './graph/model.js';
import { Inspector } from './Inspector.js';
import { connectLanguageServer } from './monaco.js';

export function App() {
    const [snapshot, setSnapshot] = useState<Snapshot>();
    const [layout, setLayout] = useState<Layout>({});
    const [selected, setSelected] = useState<string>();
    const [active, setActive] = useState<string>();
    const [reveal, setReveal] = useState<Reveal>();

    useEffect(() => {
        loadSnapshot().then(first => {
            setSnapshot(first);
            setActive(first.files[0]?.uri);
            connectLanguageServer();
        });
        loadLayout().then(setLayout);
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

    if (!snapshot || !index) return <div className="loading">Loading the model</div>;
    return (
        <div className="app">
            <header className="bar">
                <img src="/appling-icon.svg" alt="" width={20} height={20} />
                <strong>Appling</strong>
                <span className="muted">{decodeURIComponent(snapshot.root.replace('file://', ''))}</span>
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
                <GraphView index={index} dependencies={snapshot.dependencies} layout={shownLayout} selected={selected} onSelect={selectFromGraph} onMoved={moved} />
                <Inspector index={index} qn={selected} onSelect={selectFromGraph} />
            </main>
        </div>
    );
}

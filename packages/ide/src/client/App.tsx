import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentSession } from '@appling/ai';
import { DEFAULT_VIEW, type ClientReport, type SessionAct, type Snapshot, type ViewSettings } from '../shared/snapshot.js';
import type { EditOperation } from '@appling/model';
import { withRemoved } from '@appling/model/diff';
import type { Review as ReviewData, Revision } from '../shared/review.js';
import { connectLanguageServer, loadRelease, loadReview, loadRevisions, loadSnapshot, loadView, onEvents, requestEdit, saveFile, saveView } from './api.js';
import { Editor, type Reveal } from './Editor.js';
import { ModelCanvas } from '@appling/viz/canvas';
import { elementAt, GraphIndex, type SessionMark } from '@appling/viz/views';
import { Chat } from './Chat.js';
import { Inspector } from './Inspector.js';
import { Review } from './Review.js';
import { Search } from './Search.js';
import { applyTextEdits, modelTexts, monaco } from './monaco.js';

/** Inside Appling Desktop (`?shell=desktop`) the canvas is the main area, the source is folded away and there is no chat. */
const DESKTOP = new URLSearchParams(location.search).get('shell') === 'desktop';

/** Appling Desktop's hooks (`hooks.ts`), from the repo view's preload; absent elsewhere. */
const desktop = window.applingDesktop;

export function App() {
    const [source, setSource] = useState(!DESKTOP);
    const [snapshot, setSnapshot] = useState<Snapshot>();
    const [selected, setSelected] = useState<string>();
    const [active, setActive] = useState<string>();
    const [reveal, setReveal] = useState<Reveal>();
    const [release, setRelease] = useState<{ version: string } | null>(null);
    const [side, setSide] = useState<'search' | 'inspector' | 'review' | 'ai'>('search');
    const [view, setView] = useState<ViewSettings>(DEFAULT_VIEW);
    const [sessions, setSessions] = useState<AgentSession[]>([]);
    /** The elements each agent session highlighted with ide_act. */
    const [highlights, setHighlights] = useState<Record<string, string[]>>({});
    const report = useRef<(report: ClientReport) => void>(() => undefined);
    const act = useRef<(act: SessionAct) => void>(() => undefined);
    const [rev, setRev] = useState('HEAD');
    const [review, setReview] = useState<ReviewData>();
    const [revisions, setRevisions] = useState<Revision[]>([]);
    const [marked, setMarked] = useState(true);
    /** The review loads once its tab opens, then follows every snapshot and revision change. */
    const [reviewing, setReviewing] = useState(false);
    const reportUnsaved = useRef<(files: string[]) => void>(() => undefined);

    const locations = useRef<Snapshot['locations']>({});
    locations.current = snapshot?.locations ?? {};

    // the cursor in a `.appling` file of Desktop's code view selects the element there
    useEffect(() => desktop?.onCodeCursor?.((uri, offset) => {
        const qn = elementAt(locations.current, uri, offset);
        if (qn) setSelected(qn);
    }), []);

    useEffect(() => {
        loadSnapshot().then(first => {
            setSnapshot(first);
            setActive(first.files[0]?.uri);
            connectLanguageServer();
        });
        loadRelease().then(setRelease);
        loadView().then(setView);
        const events = onEvents({ snapshot: setSnapshot, sessions: setSessions, act: a => act.current(a) });
        report.current = events.report;
        reportUnsaved.current = events.unsaved;
        return events.close;
    }, []);

    // What the IDE shows, for the agent sessions' ide_context.
    useEffect(() => {
        report.current({ selection: selected, view: { ...view }, file: snapshot?.files.find(f => f.uri === active)?.path });
    }, [selected, view, active, snapshot]);

    useEffect(() => {
        if (!reviewing || !snapshot) return;
        let current = true;
        loadReview(rev).then(next => current && setReview(next));
        loadRevisions().then(next => current && setRevisions(next));
        return () => { current = false; };
    }, [reviewing, rev, snapshot]);

    const index = useMemo(() => snapshot && new GraphIndex(snapshot.graph), [snapshot]);
    /** While the review marks the canvas, it draws the working tree with the removed elements put back, ghosted. */
    const marking = reviewing && marked && review?.ok ? review : undefined;
    const canvasIndex = useMemo(() => snapshot && marking ? new GraphIndex(withRemoved(marking.before.graph, snapshot.graph, marking.diff)) : index, [index, marking]);

    /** Selects an element, reveals its source and, unless asked not to, shows it in the inspector. */
    const select = useCallback((qn: string, inspect = true) => {
        setSelected(qn);
        if (inspect) setSide('inspector');
        const location = snapshot?.locations[qn];
        if (location) {
            setActive(location.uri);
            setReveal({ ...location });
            desktop?.selected?.(location);
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

    // The actions of agent sessions (ide_act): open and reveal select, highlight marks elements on the canvas.
    act.current = (a: SessionAct) => {
        if (a.action === 'highlight') setHighlights(current => ({ ...current, [a.session]: a.elements ?? [] }));
        if ((a.action === 'open' || a.action === 'reveal') && a.elements?.[0]) select(a.elements[0], a.action === 'open');
        else if (a.action === 'open' && a.file) {
            const file = snapshot?.files.find(f => f.path === a.file);
            if (file) {
                setSource(true);
                setActive(file.uri);
                if (a.line) setReveal({ uri: file.uri, start: lineOffset(file.text, a.line), end: lineOffset(file.text, a.line) });
            }
        }
    };

    const marks = useMemo(() => {
        const repo = snapshot && decodeURIComponent(snapshot.root.replace('file://', ''));
        return sessions.filter(s => s.repo === repo).flatMap(s => [...s.claims.elements, ...highlights[s.id] ?? []].map((element): SessionMark => ({ element, color: s.color, label: s.label ?? s.name, session: s.id })));
    }, [sessions, highlights, snapshot]);

    if (!snapshot || !index || !canvasIndex) return <div className="loading">Loading the model</div>;
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
                {DESKTOP && <button className="button" aria-pressed={source} onClick={() => setSource(!source)}>{source ? 'Hide source' : 'Source'}</button>}
            </header>
            <main className={`panes${source ? '' : ' no-source'}${DESKTOP ? ' desktop' : ''}`}>
                <Editor
                    files={snapshot.files}
                    active={active}
                    reveal={reveal}
                    onActive={setActive}
                    onCursor={(uri, offset) => setSelected(elementAt(snapshot.locations, uri, offset))}
                    onSave={(path, text) => saveFile(path, text)}
                    onDirty={uris => reportUnsaved.current(snapshot.files.filter(f => uris.includes(f.uri)).map(f => f.path))}
                />
                <ModelCanvas index={canvasIndex} changes={marking?.diff} name={decodeURIComponent(snapshot.root).split('/').pop()} selected={selected} settings={view} sessions={marks} onSelect={select} onSettings={next => { setView(next); saveView(next); }} />
                <div className="side">
                    <nav className="tabs" aria-label="Side panel">
                        <button className={side === 'search' ? 'active' : ''} onClick={() => setSide('search')}>Search</button>
                        <button className={side === 'inspector' ? 'active' : ''} onClick={() => setSide('inspector')}>Inspector</button>
                        <button className={side === 'review' ? 'active' : ''} onClick={() => { setSide('review'); setReviewing(true); }}>Review</button>
                        {!DESKTOP && <button className={side === 'ai' ? 'active' : ''} onClick={() => setSide('ai')}>AI</button>}
                    </nav>
                    <div hidden={side !== 'search'} className="side-panel"><Search index={index} onSelect={select} /></div>
                    <div hidden={side !== 'inspector'} className="side-panel"><Inspector index={index} qn={selected} code={selected ? snapshot.code[selected] ?? [] : []} onSelect={select} onEdit={edit} /></div>
                    <div hidden={side !== 'review'} className="side-panel">
                        {reviewing && <Review snapshot={snapshot} review={review} rev={rev} revisions={revisions} marked={marked} onRev={next => { setReview(undefined); setRev(next); }} onMarked={setMarked} onSelect={qn => select(qn, false)} />}
                    </div>
                    {!DESKTOP && <div hidden={side !== 'ai'} className="side-panel"><Chat onEdit={edit} onSelect={qn => select(qn, false)} /></div>}
                </div>
            </main>
        </div>
    );
}

function lineOffset(text: string, line: number): number {
    let offset = 0;
    for (let i = 1; i < line && offset >= 0; i++) offset = text.indexOf('\n', offset) + 1 || text.length;
    return offset;
}

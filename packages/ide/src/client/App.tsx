import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentSession, Chapter, Playbook, PlaybookPosition } from '@appling/ai';
import { DEFAULT_VIEW, type ClientReport, type GenerationRun, type SessionAct, type Snapshot, type ViewSettings } from '../shared/snapshot.js';
import type { GenerationSelection } from '@appling/codegen';
import { lineMarks } from '@appling/model/implementation';
import type { EditOperation } from '@appling/model';
import { withRemoved } from '@appling/model/diff';
import type { Review as ReviewData, Revision } from '../shared/review.js';
import type { AgentView, LiveChanges, Proposal } from '../shared/live.js';
import { acceptChanges, connectLanguageServer, SOURCE_OPEN, decideProposal, loadCode, loadPlaybook, loadRelease, loadReview, loadRevisions, loadSnapshot, loadView, movePlaybook, onEvents, requestEdit, respondToStep, revertChange, saveFile, saveView, startGeneration } from './api.js';
import { Implementation } from './Implementation.js';
import type { OpenCode } from './CodeView.js';
import { AgentCanvas, AgentStrip } from './AgentView.js';
import { Live } from './Live.js';
import { PlaybookPanel, PlaybookPlayer } from './Playbook.js';
import { unwatchedCounts } from '../shared/player.js';
import { Editor, type Reveal } from './Editor.js';
import { ModelCanvas } from '@appling/viz/canvas';
import { elementAt, GraphIndex, type SessionMark } from '@appling/viz/views';
import { Inspector } from './Inspector.js';
import { Review } from './Review.js';
import { Search } from './Search.js';
import { applyTextEdits, modelTexts, monaco } from './monaco.js';

/** Appling Desktop's hooks (`hooks.ts`), from the repo view's preload; absent elsewhere. */
const desktop = window.applingDesktop;

export function App() {
    const [source, setSource] = useState(SOURCE_OPEN);
    const [snapshot, setSnapshot] = useState<Snapshot>();
    const [selected, setSelected] = useState<string>();
    const [active, setActive] = useState<string>();
    const [reveal, setReveal] = useState<Reveal>();
    const [release, setRelease] = useState<{ version: string } | null>(null);
    const [side, setSide] = useState<'search' | 'inspector' | 'changes' | 'review' | 'playbook' | 'code'>('search');
    /** The generation running or last run, the code file shown in place of the model, and whether to offer generation. */
    const [run, setRun] = useState<GenerationRun>();
    const [code, setCode] = useState<OpenCode>();
    const [offer, setOffer] = useState(0);
    const outstandingBefore = useRef<number>(undefined);
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
    /** Every model change since the user last accepted, marked live on the canvas. */
    const [live, setLive] = useState<LiveChanges>();
    /** What each agent session shows with the visual tools, and the session whose view the canvas shows. */
    const [agentViews, setAgentViews] = useState<Record<string, AgentView>>({});
    const [watching, setWatching] = useState<string>();
    const [proposals, setProposals] = useState<Proposal[]>([]);
    /** The workspace's playbook (#19); the canvas plays it only while `playing`, and moves only on the user's steps. */
    const [playbook, setPlaybook] = useState<Playbook>();
    const [playing, setPlaying] = useState(false);
    /** The session whose changes the Changes tab shows alone, after a chapter jumped to its diff. */
    const [changesOf, setChangesOf] = useState<string>();

    useEffect(() => {
        loadSnapshot().then(first => {
            setSnapshot(first);
            setActive(first.files[0]?.uri);
            connectLanguageServer();
        });
        loadRelease().then(setRelease);
        loadView().then(setView);
        loadPlaybook().then(setPlaybook);
        // A repo view shared by several workspaces plays the playbook of the one shown; reload it when shown again.
        const shown = () => { if (document.visibilityState === 'visible') loadPlaybook().then(setPlaybook); };
        document.addEventListener('visibilitychange', shown);
        addEventListener('focus', shown);
        const events = onEvents({
            playbook: setPlaybook,
            snapshot: setSnapshot, sessions: setSessions, act: a => act.current(a), live: setLive, proposals: setProposals,
            generation: setRun,
            generationEvent: (id, event) => setRun(current => current?.id === id ? { ...current, events: [...current.events, event] } : current),
            agentView: (next, ended) => setAgentViews(current => {
                const { [next.session]: _, ...rest } = current;
                return ended ? rest : { ...rest, [next.session]: next };
            })
        });
        report.current = events.report;
        reportUnsaved.current = events.unsaved;
        return () => {
            events.close();
            document.removeEventListener('visibilitychange', shown);
            removeEventListener('focus', shown);
        };
    }, []);

    // What the IDE shows, for the agent sessions' ide_context.
    useEffect(() => {
        report.current({ selection: selected, view: { ...view }, file: snapshot?.files.find(f => f.uri === active)?.path, watching });
    }, [selected, view, active, snapshot, watching]);

    // The view of a session that ended closes.
    useEffect(() => { if (watching && !agentViews[watching]?.show) setWatching(undefined); }, [agentViews, watching]);

    useEffect(() => {
        if (!reviewing || !snapshot) return;
        let current = true;
        loadReview(rev).then(next => current && setReview(next));
        loadRevisions().then(next => current && setRevisions(next));
        return () => { current = false; };
    }, [reviewing, rev, snapshot]);

    const index = useMemo(() => snapshot && new GraphIndex(snapshot.graph), [snapshot]);
    const marks = useMemo(() => snapshot && lineMarks(snapshot.locations, Object.fromEntries(snapshot.files.map(f => [f.uri, f.text])), snapshot.implementation), [snapshot]);

    // After a model change adds outstanding elements (new or changed since the last generation), generation is offered.
    useEffect(() => {
        if (!snapshot?.targets.length) return;
        const count = Object.values(snapshot.implementation).filter(i => i.outstanding).length;
        if (outstandingBefore.current !== undefined && count > outstandingBefore.current) setOffer(count);
        if (!count) setOffer(0);
        outstandingBefore.current = count;
    }, [snapshot]);

    const generate = useCallback((selection: GenerationSelection) => {
        setOffer(0);
        setSide('code');
        startGeneration(selection).then(setRun, error => alert((error as Error).message));
    }, []);
    /** While the review marks the canvas, it draws the working tree with the removed elements put back, ghosted. */
    const marking = reviewing && marked && review?.ok ? review : undefined;
    /** Otherwise the live changes are marked, with the removed elements ghosted; marks never move the camera. */
    const liveMarks = !marking && live?.files.length ? live : undefined;
    const canvasIndex = useMemo(() => {
        if (!snapshot) return undefined;
        if (marking) return new GraphIndex(withRemoved(marking.before.graph, snapshot.graph, marking.diff));
        if (liveMarks?.ghosts.nodes.length) return new GraphIndex({ nodes: [...snapshot.graph.nodes, ...liveMarks.ghosts.nodes], edges: [...snapshot.graph.edges, ...liveMarks.ghosts.edges] });
        return index;
    }, [index, marking, liveMarks]);
    const canvasChanges = marking?.diff ?? liveMarks?.diff;

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

    /** Jumps to an element's code: in Desktop's code view when there is one, else read only in place of the model. */
    const openCode = useCallback((qn: string) => {
        const reference = snapshot?.code[qn]?.find(c => c.status !== 'broken') ?? snapshot?.code[qn]?.[0];
        if (!reference) return select(qn);
        if (desktop?.openCode) return desktop.openCode({ path: reference.file, start: reference.start, end: reference.end });
        loadCode(reference.file).then(file => {
            setSource(true);
            setCode({ ...file, start: reference.start, end: reference.end, qn });
        }, error => alert((error as Error).message));
    }, [snapshot, select]);

    // the Appling extension's CodeLens in Desktop's code view: from code back to its element
    const selectRef = useRef(select);
    selectRef.current = select;
    useEffect(() => { desktop?.onCodeElement?.(qn => selectRef.current(qn)); }, []);

    /** Opens a model file in the source, at a line. */
    const openFile = (path: string, line?: number) => {
        const file = snapshot?.files.find(f => f.path === path);
        if (!file) return;
        setSource(true);
        setActive(file.uri);
        if (line) setReveal({ uri: file.uri, start: lineOffset(file.text, line), end: lineOffset(file.text, line) });
    };

    // The actions of agent sessions (ide_act): open and reveal select, highlight marks elements on the canvas.
    act.current = (a: SessionAct) => {
        if (a.action === 'highlight') setHighlights(current => ({ ...current, [a.session]: a.elements ?? [] }));
        if ((a.action === 'open' || a.action === 'reveal') && a.elements?.[0]) select(a.elements[0], a.action === 'open');
        else if (a.action === 'open' && a.file) openFile(a.file, a.line);
    };

    const sessionMarks = useMemo(() => {
        const repo = snapshot && decodeURIComponent(snapshot.root.replace('file://', ''));
        return sessions.filter(s => s.repo === repo).flatMap(s => [...s.claims.elements, ...highlights[s.id] ?? []].map((element): SessionMark => ({ element, color: s.color, label: s.label ?? s.name, session: s.id })));
    }, [sessions, highlights, snapshot]);

    /** The user steps in the playbook: shown at once, then stored, where the sessions read it. */
    const movePlay = (position: PlaybookPosition) => {
        if (!playbook) return;
        setPlaybook({ ...playbook, position });
        setPlaying(true);
        movePlaybook(playbook.workspace, position).then(setPlaybook, error => alert((error as Error).message));
    };
    /** A chapter jumps to its session: its tab in Appling Desktop, else its view on the canvas. */
    const toSession = (chapter: Chapter) => {
        if (!chapter.session) return;
        if (desktop?.focusSession) return desktop.focusSession(chapter.session);
        if (agentViews[chapter.session]?.show) {
            setPlaying(false);
            setWatching(chapter.session);
        }
    };
    const toDiff = (chapter: Chapter) => {
        setChangesOf(chapter.session);
        setSide('changes');
    };
    const unwatchedCount = unwatchedCounts(playbook).total;

    if (!snapshot || !index || !canvasIndex) return <div className="loading">Loading the model</div>;
    const block = release && `since_v${release.version.replaceAll('.', '_')}`;
    const pending = block ? snapshot.graph.nodes.filter(n => n.kind === 'Migration' && n.qn.endsWith(`.${block}`)) : [];
    const steps = pending.reduce((count, m) => count + ((m.props.steps as string[] | undefined)?.length ?? 0), 0);
    const watched = watching ? agentViews[watching] : undefined;
    const unseenCount = live?.files.length ?? 0;
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
                <button className="button" aria-pressed={source} onClick={() => setSource(!source)}>{source ? 'Hide source' : 'Source'}</button>
            </header>
            <main className={`panes${source ? '' : ' no-source'}`}>
                <Editor
                    files={snapshot.files}
                    active={active}
                    reveal={reveal}
                    onActive={setActive}
                    onCursor={(uri, offset) => setSelected(elementAt(snapshot.locations, uri, offset))}
                    onSave={(path, text) => saveFile(path, text)}
                    onDirty={uris => reportUnsaved.current(snapshot.files.filter(f => uris.includes(f.uri)).map(f => f.path))}
                    marks={marks}
                    onMark={openCode}
                    code={code}
                    onCloseCode={() => setCode(undefined)}
                />
                <div className="canvas-area">
                    {playing && playbook?.position.chapter
                        ? <PlaybookPlayer index={canvasIndex} playbook={playbook} settings={view} selected={selected} repo={decodeURIComponent(snapshot.root.replace('file://', ''))}
                            onMove={movePlay} onRespond={async (chapter, step, kind, text) => { await respondToStep(chapter, step, kind, text).catch(error => alert((error as Error).message)); }}
                            onSelect={qn => select(qn, false)} onClose={() => setPlaying(false)} onSession={toSession} onDiff={toDiff} />
                        : watched?.show
                        ? <AgentCanvas key={watched.session} index={canvasIndex} view={watched} session={sessions.find(s => s.id === watched.session)} settings={view} selected={selected} changes={canvasChanges} onSelect={qn => select(qn, false)} onClose={() => setWatching(undefined)} onOpenFile={openFile} />
                        : <ModelCanvas index={canvasIndex} changes={canvasChanges} name={decodeURIComponent(snapshot.root).split('/').pop()} selected={selected} settings={view} sessions={sessionMarks} onSession={desktop?.focusSession} implementation={snapshot.implementation} onSelect={select} onSettings={next => { setView(next); saveView(next); }} />}
                    {!playing && unwatchedCount > 0 && (
                        <button className="playbook-chip" onClick={() => { setSide('playbook'); }}>{unwatchedCount} playbook chapter{unwatchedCount > 1 ? 's' : ''} to watch</button>
                    )}
                    <AgentStrip views={Object.values(agentViews)} sessions={sessions} watching={watching} onWatch={setWatching} />
                    {offer > 0 && !(run && !run.ended) && (
                        <div className="generate-offer" role="status">
                            {offer} element{offer > 1 ? 's' : ''} new or changed since the last generation
                            <button className="button" onClick={() => generate({ mode: 'outstanding' })}>Generate</button>
                            <button className="button" onClick={() => setOffer(0)}>Not now</button>
                        </div>
                    )}
                    {proposals.length > 0 && side !== 'changes' && (
                        <button className="proposal-banner" onClick={() => setSide('changes')}>{proposals.length} proposed change{proposals.length > 1 ? 's' : ''} wait{proposals.length > 1 ? '' : 's'} for your decision</button>
                    )}
                </div>
                <div className="side">
                    <nav className="tabs" aria-label="Side panel">
                        <button className={side === 'search' ? 'active' : ''} onClick={() => setSide('search')}>Search</button>
                        <button className={side === 'inspector' ? 'active' : ''} onClick={() => setSide('inspector')}>Inspector</button>
                        <button className={side === 'changes' ? 'active' : ''} onClick={() => setSide('changes')}>Changes{unseenCount + proposals.length > 0 && <span className="tab-count">{unseenCount + proposals.length}</span>}</button>
                        <button className={side === 'playbook' ? 'active' : ''} onClick={() => setSide('playbook')}>Playbook{unwatchedCount > 0 && <span className="tab-count">{unwatchedCount}</span>}</button>
                        <button className={side === 'review' ? 'active' : ''} onClick={() => { setSide('review'); setReviewing(true); }}>Review</button>
                        <button className={side === 'code' ? 'active' : ''} onClick={() => setSide('code')}>Code{snapshot.tasks.length > 0 && <span className="tab-count">{snapshot.tasks.length}</span>}</button>
                    </nav>
                    <div hidden={side !== 'search'} className="side-panel"><Search index={index} onSelect={select} /></div>
                    <div hidden={side !== 'inspector'} className="side-panel"><Inspector index={index} qn={selected} code={selected ? snapshot.code[selected] ?? [] : []} implementation={selected ? snapshot.implementation[selected] : undefined} canGenerate={snapshot.targets.length > 0 && !(run && !run.ended)} onSelect={select} onEdit={edit} onOpenCode={openCode} onGenerate={qn => generate({ mode: 'elements', elements: [qn] })} /></div>
                    <div hidden={side !== 'code'} className="side-panel"><Implementation snapshot={snapshot} run={run} sessions={sessions} selected={selected} onSelect={qn => select(qn, false)} onGenerate={generate} /></div>
                    <div hidden={side !== 'changes'} className="side-panel">
                        <Live live={live} proposals={proposals} sessions={sessions}
                            onAccept={paths => acceptChanges(paths).then(setLive)} onRevert={path => revertChange(path).catch(error => alert((error as Error).message))}
                            onDecide={(id, decision) => decideProposal(id, decision).catch(error => alert((error as Error).message))}
                            onSelect={qn => select(qn, false)} session={changesOf} onAllSessions={() => setChangesOf(undefined)} />
                    </div>
                    <div hidden={side !== 'playbook'} className="side-panel">
                        <PlaybookPanel playbook={playbook} sessions={sessions} playing={playing} onPlay={movePlay} onSession={toSession} onDiff={toDiff} />
                    </div>
                    <div hidden={side !== 'review'} className="side-panel">
                        {reviewing && <Review snapshot={snapshot} review={review} rev={rev} revisions={revisions} marked={marked} onRev={next => { setReview(undefined); setRev(next); }} onMarked={setMarked} onSelect={qn => select(qn, false)} />}
                    </div>
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

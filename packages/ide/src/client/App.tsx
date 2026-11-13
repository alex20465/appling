import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentSession } from '@appling/ai';
import { DEFAULT_VIEW, type ClientReport, type GenerationRun, type SessionAct, type Snapshot, type ViewSettings } from '../shared/snapshot.js';
import type { GenerationSelection } from '@appling/codegen';
import { STACK_LABELS, type Stack } from '@appling/codegen/stacks';
import { lineMarks } from '@appling/model/implementation';
import type { EditOperation } from '@appling/model';
import { withRemoved } from '@appling/model/diff';
import { anchorOwner, isAnchorAddress } from '@appling/model/anchors';
import { elementTextDiff, type Review as ReviewData, type Revision } from '../shared/review.js';
import type { PanelAction, PanelName } from '../shared/panels.js';
import { openTextDiff } from './hooks.js';
import type { AgentView, LiveChanges, Proposal } from '../shared/live.js';
import { acceptChanges, addRequest, addTarget, connectLanguageServer, SOURCE_OPEN, decideProposal, loadCode, loadRelease, loadReview, loadRevisions, loadSnapshot, loadView, onEvents, removeRequest, requestEdit, revertChange, saveFile, saveView, startGeneration, updateRequest } from './api.js';
import { Implementation } from './Implementation.js';
import { TaskBoard } from './TaskBoard.js';
import type { OpenCode } from './CodeView.js';
import { AgentCanvas, AgentStrip } from './AgentView.js';
import { Live } from './Live.js';
import { Editor, type Reveal } from './Editor.js';
import { ModelCanvas, type NodeMenu } from '@appling/viz/canvas';
import { elementAt, GraphIndex, type SessionMark } from '@appling/viz/views';
import { Inspector } from './Inspector.js';
import { Review } from './Review.js';
import { Search } from './Search.js';
import { applyTextEdits, modelTexts, monaco } from './monaco.js';

/** Appling Desktop's hooks (`hooks.ts`), from the repo view's preload; absent elsewhere. */
const desktop = window.applingDesktop;

/** An error for the user: in the host where it shows them (a webview blocks `alert`), else an alert. */
function fail(error: unknown): void {
    const message = (error as Error).message;
    if (desktop?.showError) desktop.showError(message);
    else alert(message);
}

export function App() {
    const [source, setSource] = useState(SOURCE_OPEN);
    const [snapshot, setSnapshot] = useState<Snapshot>();
    const [selected, setSelected] = useState<string>();
    const [active, setActive] = useState<string>();
    const [reveal, setReveal] = useState<Reveal>();
    const [release, setRelease] = useState<{ version: string } | null>(null);
    const [side, setSide] = useState<PanelName>('search');
    /** Shows a side panel: the host's, where the host draws them. */
    const show = (name: PanelName) => desktop?.showPanel ? desktop.showPanel(name) : setSide(name);
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
    /** Whether the task board lies over the canvas. */
    const [board, setBoard] = useState(false);
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

    useEffect(() => {
        loadSnapshot().then(first => {
            setSnapshot(first);
            setActive(first.files[0]?.uri);
            connectLanguageServer();
        });
        loadRelease().then(setRelease);
        loadView().then(setView);
        const events = onEvents({
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
        return () => events.close();
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
    const marks = useMemo(() => snapshot && lineMarks(snapshot.locations, Object.fromEntries(snapshot.files.map(f => [f.uri, f.text])), { ...snapshot.implementation, ...snapshot.anchors }), [snapshot]);

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
        show('code');
        startGeneration(selection).then(setRun, fail);
    }, []);
    /** The selection waiting for a stack, while the picker asks for one. */
    const [picking, setPicking] = useState<GenerationSelection>();
    /** Generation needs a target: without one the host asks for a stack (VS Code's quick pick), else the picker does. */
    const generateFor = (selection: GenerationSelection) => {
        if (snapshot?.targets.length) generate(selection);
        else if (desktop?.chooseStack) desktop.chooseStack(selection);
        else setPicking(selection);
    };
    const pickStack = (stack: Stack) => {
        const selection = picking!;
        setPicking(undefined);
        addTarget(stack).then(() => generate(selection), fail);
    };
    const running = !!run && !run.ended;
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
    /** The selected element: a selected sub-anchor (a use case step, a `requires`…) shows its element on the canvas. */
    const element = selected && !index?.nodes.has(selected) && isAnchorAddress(selected) ? anchorOwner(selected) : selected;
    const anchor = selected && element !== selected ? selected : undefined;
    /**
     * The application comes first: until a target was generated the canvas offers only that (the first generation
     * creates it from the whole model); then the selected element, while it has no code.
     */
    const generated = !!snapshot?.targets.some(t => t.generated);
    const unimplemented = element && snapshot?.implementation[element] && snapshot.implementation[element].state !== 'implemented';
    const canvasAction = !snapshot || running || !Object.keys(snapshot.implementation).length ? undefined
        : !generated ? { label: 'Generate the application', hint: 'Elements generate one by one once it exists', run: () => generateFor({ mode: 'all' }) }
        : unimplemented ? { label: `Generate ${element.split('.').pop()}`, run: () => generateFor({ mode: 'elements', elements: [element] }) }
        : undefined;
    const selectedChange = element ? canvasChanges?.changes.find(c => c.qn === element) : undefined;
    /** The text diff the Inspector shows itself, without Desktop's code view, and the live file the Changes tab opens. */
    const [inspectorDiff, setInspectorDiff] = useState<{ qn: string, before: string, after: string }>();
    const [liveOpen, setLiveOpen] = useState<{ path: string }>();
    /** A changed element selected on the canvas: its text diff in the code view, as from the Review list (#12). */
    const textDiff = (qn: string) => {
        const change = canvasChanges?.changes.find(c => c.qn === qn);
        if (!change || !snapshot) return;
        if (marking) {
            const diff = elementTextDiff(change, marking, snapshot);
            if (!openTextDiff(diff.request)) setInspectorDiff(inspectorDiff?.qn === qn ? undefined : { qn, before: diff.before, after: diff.after });
            return;
        }
        // live changes compare with the text last accepted, not a commit: the Changes tab shows that file's diff
        const file = liveMarks?.files.find(f => f.elements.includes(qn));
        if (!file) return;
        setLiveOpen({ path: file.path });
        show('changes');
    };

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

    /** The right click menu of the canvas nodes: edits go through the host's editors where it has them (VS Code). */
    const nodeMenu = useMemo<NodeMenu>(() => ({
        onEdit: qn => {
            select(qn);
            show('inspector');
        },
        onRemove: qn => {
            const operation: EditOperation = { op: 'remove', target: qn };
            if (desktop?.edit) return desktop.edit(operation);
            edit(operation).then(errors => { if (errors.length) fail(new Error(`Could not remove ${qn}: ${errors.join('; ')}`)); }, fail);
        },
        onRequest: request => { addRequest(request).catch(fail); },
        onEditRequest: (id, change) => { updateRequest(id, change).catch(fail); },
        onRemoveRequest: id => { removeRequest(id).catch(fail); }
    }), [select, edit]);

    /** Jumps to an element's code: in Desktop's code view when there is one, else read only in place of the model. */
    const openCode = useCallback((qn: string) => {
        const reference = snapshot?.code[qn]?.find(c => c.status !== 'broken') ?? snapshot?.code[qn]?.[0];
        if (!reference) return select(qn);
        if (desktop?.openCode) return desktop.openCode({ path: reference.file, start: reference.start, end: reference.end });
        loadCode(reference.file).then(file => {
            setSource(true);
            setCode({ ...file, start: reference.start, end: reference.end, qn });
        }, fail);
    }, [snapshot, select]);

    /** Go to Implementation in the source: the code of the element there, or of the nearest element around it that has code. */
    const implementationAt = (uri: string, offset: number) => {
        const at = snapshot && elementAt(snapshot.locations, uri, offset);
        if (!at || !snapshot || !index) return;
        const declared = at.split('#')[0];
        const coded = [at, ...index.lineage(declared)].find(qn => snapshot.code[qn]?.length);
        if (coded) return openCode(coded);
        fail(new Error(`${declared} has no code yet. Generate it from the Code tab.`));
    };

    // the Appling extension's CodeLens in Desktop's code view: from code back to its element
    const selectRef = useRef(select);
    selectRef.current = select;
    useEffect(() => { desktop?.onCodeElement?.(qn => selectRef.current(qn)); }, []);

    /** Opens an element's source in the host's editor (on the user's request; the canvas selection stays in the IDE). */
    const openSource = desktop?.openSource && ((qn: string) => {
        const location = snapshot?.locations[qn];
        if (location) desktop.openSource!(location);
    });

    /** Opens a model file in the source, at a line: in the host's editor when it offers one. */
    const openFile = (path: string, line?: number) => {
        const file = snapshot?.files.find(f => f.path === path);
        if (!file) return;
        const offset = line ? lineOffset(file.text, line) : 0;
        if (desktop?.openSource) return desktop.openSource({ uri: file.uri, start: offset, end: offset });
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
        return sessions.filter(s => s.repo === repo).flatMap(s => [...s.claims.elements, ...highlights[s.id] ?? [], ...snapshot!.requests.filter(r => r.takenBy === s.id).map(r => `?${r.id}`)].map((element): SessionMark => ({ element, color: s.color, label: s.label ?? s.name, session: s.id })));
    }, [sessions, highlights, snapshot]);


    // The host's side panels: what they show, sent after the changes settle, and what they ask.
    useEffect(() => {
        if (!snapshot || !desktop?.panels) return;
        const timer = setTimeout(() => desktop.panels!({
            snapshot: { ...snapshot, files: snapshot.files.map(({ uri, path }) => ({ uri, path })) },
            selected, live, proposals, sessions, run,
            review: { on: reviewing, rev, marked, revisions, result: review && (review.ok ? { ok: true, commit: review.commit, diff: review.diff, files: review.files } : review) }
        }), 50);
        return () => clearTimeout(timer);
    }, [snapshot, selected, live, proposals, sessions, run, reviewing, rev, marked, revisions, review]);
    const panelAction = useRef<(action: PanelAction) => void>(() => undefined);
    panelAction.current = action => {
        switch (action.type) {
            case 'select': return select(action.qn, false);
            case 'generate': return generate(action.selection);
            case 'textDiff': return textDiff(action.qn);
            case 'accept': return void acceptChanges(action.paths).then(setLive, fail);
            case 'revert': return void revertChange(action.path).catch(fail);
            case 'decide': return void decideProposal(action.id, action.decision).catch(fail);
            case 'review':
                if (action.on !== undefined) setReviewing(action.on);
                if (action.rev !== undefined && action.rev !== rev) { setReview(undefined); setRev(action.rev); }
                if (action.marked !== undefined) setMarked(action.marked);
        }
    };
    useEffect(() => { desktop?.onPanelAction?.(action => panelAction.current(action)); }, []);

    if (!snapshot || !index || !canvasIndex) return <div className="loading">Loading the model</div>;
    const block = release && `since_v${release.version.replaceAll('.', '_')}`;
    const pending = block ? snapshot.graph.nodes.filter(n => n.kind === 'Migration' && n.qn.endsWith(`.${block}`)) : [];
    const steps = pending.reduce((count, m) => count + ((m.props.steps as string[] | undefined)?.length ?? 0), 0);
    const watched = watching ? agentViews[watching] : undefined;
    const unseenCount = live?.files.length ?? 0;
    const openTasks = snapshot.tasks.filter(t => t.status !== 'done').length;
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
                {!desktop?.openSource && <button className="button" aria-pressed={source} onClick={() => setSource(!source)}>{source ? 'Hide source' : 'Source'}</button>}
            </header>
            <main className={`panes${source ? '' : ' no-source'}${desktop?.panels ? ' no-side' : ''}`}>
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
                    references={snapshot.code}
                    onImplementationAt={implementationAt}
                    code={code}
                    onCloseCode={() => setCode(undefined)}
                />
                <div className="canvas-area">
                    {watched?.show
                        ? <AgentCanvas key={watched.session} index={canvasIndex} view={watched} session={sessions.find(s => s.id === watched.session)} settings={view} selected={element} changes={canvasChanges} onSelect={qn => select(qn, false)} onClose={() => setWatching(undefined)} onOpenFile={openFile} />
                        : <ModelCanvas index={canvasIndex} changes={canvasChanges} name={decodeURIComponent(snapshot.root).split('/').pop()} selected={element} settings={view} sessions={sessionMarks} onSession={desktop?.focusSession} implementation={snapshot.implementation} requests={snapshot.requests} menu={nodeMenu} action={canvasAction} buttons={[{ label: openTasks ? `Tasks ${openTasks}` : 'Tasks', pressed: board, run: () => setBoard(!board) }]} onSelect={select} onSettings={next => { setView(next); saveView(next); }} />}
                    {picking && (
                        <div className="stack-picker" role="dialog" aria-label="Choose a stack">
                            <h3>Generate with which stack?</h3>
                            <p className="muted">It is added to appling.config.json; the first generation creates the whole application.</p>
                            <div className="generate-actions">
                                {(Object.keys(STACK_LABELS) as Stack[]).map(stack => <button key={stack} className="button" onClick={() => pickStack(stack)}>{STACK_LABELS[stack]}</button>)}
                                <button className="button" onClick={() => setPicking(undefined)}>Cancel</button>
                            </div>
                        </div>
                    )}
                    {board && !watched?.show && <TaskBoard tasks={snapshot.tasks} sessions={sessions} selected={element} onSelect={qn => select(qn, false)} onClose={() => setBoard(false)} />}
                    <AgentStrip views={Object.values(agentViews)} sessions={sessions} watching={watching} onWatch={setWatching} />
                    {offer > 0 && !(run && !run.ended) && (
                        <div className="generate-offer" role="status">
                            {offer} element{offer > 1 ? 's' : ''} new or changed since the last generation
                            <button className="button" onClick={() => generate({ mode: 'outstanding' })}>Generate</button>
                            <button className="button" onClick={() => setOffer(0)}>Not now</button>
                        </div>
                    )}
                    {proposals.length > 0 && (side !== 'changes' || desktop?.panels) && (
                        <button className="proposal-banner" onClick={() => show('changes')}>{proposals.length} proposed change{proposals.length > 1 ? 's' : ''} wait{proposals.length > 1 ? '' : 's'} for your decision</button>
                    )}
                </div>
                {!desktop?.panels && <div className="side">
                    <nav className="tabs" aria-label="Side panel">
                        <button className={side === 'search' ? 'active' : ''} onClick={() => setSide('search')}>Search</button>
                        <button className={side === 'inspector' ? 'active' : ''} onClick={() => setSide('inspector')}>Inspector</button>
                        <button className={side === 'changes' ? 'active' : ''} onClick={() => setSide('changes')}>Changes{unseenCount + proposals.length > 0 && <span className="tab-count">{unseenCount + proposals.length}</span>}</button>
                        <button className={side === 'review' ? 'active' : ''} onClick={() => { setSide('review'); setReviewing(true); }}>Review</button>
                        <button className={side === 'code' ? 'active' : ''} onClick={() => setSide('code')}>Code{openTasks > 0 && <span className="tab-count">{openTasks}</span>}</button>
                    </nav>
                    <div hidden={side !== 'search'} className="side-panel"><Search index={index} onSelect={select} /></div>
                    <div hidden={side !== 'inspector'} className="side-panel"><Inspector index={index} qn={element} code={element ? snapshot.code[element] ?? [] : []} implementation={element ? snapshot.implementation[element] : undefined}
                        anchor={anchor ? { address: anchor, code: snapshot.code[anchor] ?? [], implementation: snapshot.anchors[anchor] } : undefined} canGenerate={!running && generated} onSelect={select} onEdit={edit} onOpenCode={openCode} onOpenSource={openSource} onGenerate={qn => generateFor({ mode: 'elements', elements: [qn] })} change={selectedChange} onTextDiff={textDiff} diff={inspectorDiff} /></div>
                    <div hidden={side !== 'code'} className="side-panel"><Implementation snapshot={snapshot} run={run} sessions={sessions} selected={element} onSelect={qn => select(qn, false)} onGenerate={generateFor} /></div>
                    <div hidden={side !== 'changes'} className="side-panel">
                        <Live live={live} proposals={proposals} sessions={sessions}
                            onAccept={paths => acceptChanges(paths).then(setLive)} onRevert={path => revertChange(path).catch(fail)}
                            onDecide={(id, decision) => decideProposal(id, decision).catch(fail)}
                            onSelect={qn => select(qn, false)} openPath={liveOpen} />
                    </div>
                    <div hidden={side !== 'review'} className="side-panel">
                        {reviewing && <Review snapshot={snapshot} review={review} rev={rev} revisions={revisions} marked={marked} onRev={next => { setReview(undefined); setRev(next); }} onMarked={setMarked} onSelect={qn => select(qn, false)} />}
                    </div>
                </div>}
            </main>
        </div>
    );
}

function lineOffset(text: string, line: number): number {
    let offset = 0;
    for (let i = 1; i < line && offset >= 0; i++) offset = text.indexOf('\n', offset) + 1 || text.length;
    return offset;
}

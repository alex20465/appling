import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentSession } from '@appling/ai';
import { DEFAULT_VIEW, type ClientReport, type SessionAct, type Snapshot, type ViewSettings } from '../shared/snapshot.js';
import { withRemoved } from '@appling/model/diff';
import { anchorOwner, isAnchorAddress } from '@appling/model/anchors';
import { elementTextDiff, type Review, type Revision } from '../shared/review.js';
import type { PanelAction } from '../shared/panels.js';
import { openTextDiff } from './hooks.js';
import type { AgentView, LiveChanges } from '../shared/live.js';
import { loadRelease, loadReview, loadRevisions, loadSnapshot, loadView, onEvents, saveView } from './api.js';
import { TaskBoard } from './TaskBoard.js';
import { AgentCanvas, AgentStrip } from './AgentView.js';
import { ModelCanvas } from '@appling/viz/canvas';
import { elementAt, GraphIndex, type SessionMark } from '@appling/viz/views';
import { Inspector } from './Inspector.js';

/** The hooks of the page that embeds the inspector (`hooks.ts`), such as VS Code's; absent in a plain browser. */
const host = window.applingHost;

export function App() {
    const [snapshot, setSnapshot] = useState<Snapshot>();
    const [selected, setSelected] = useState<string>();
    const [release, setRelease] = useState<{ version: string } | null>(null);
    const [view, setView] = useState<ViewSettings>(DEFAULT_VIEW);
    const [sessions, setSessions] = useState<AgentSession[]>([]);
    /** The elements each agent session highlighted with ide_act. */
    const [highlights, setHighlights] = useState<Record<string, string[]>>({});
    const report = useRef<(report: ClientReport) => void>(() => undefined);
    const act = useRef<(act: SessionAct) => void>(() => undefined);
    /** The review of the host's Review panel: it loads once the panel turns it on, then follows every snapshot and revision change. */
    const [reviewing, setReviewing] = useState(false);
    const [rev, setRev] = useState('HEAD');
    const [review, setReview] = useState<Review>();
    const [revisions, setRevisions] = useState<Revision[]>([]);
    const [marked, setMarked] = useState(true);
    /** Whether the task board lies over the canvas. */
    const [board, setBoard] = useState(false);

    const locations = useRef<Snapshot['locations']>({});
    locations.current = snapshot?.locations ?? {};

    // the cursor in a `.appling` editor of the host selects the element there
    useEffect(() => host?.onCodeCursor?.((uri, offset) => {
        const qn = elementAt(locations.current, uri, offset);
        if (qn) setSelected(qn);
    }), []);
    /** Every model change against the baseline, marked live on the canvas. */
    const [live, setLive] = useState<LiveChanges>();
    /** What each agent session shows with the visual tools, and the session whose view the canvas shows. */
    const [agentViews, setAgentViews] = useState<Record<string, AgentView>>({});
    const [watching, setWatching] = useState<string>();

    useEffect(() => {
        loadSnapshot().then(setSnapshot);
        loadRelease().then(setRelease);
        loadView().then(setView);
        const events = onEvents({
            snapshot: setSnapshot, sessions: setSessions, act: a => act.current(a), live: setLive,
            agentView: (next, ended) => setAgentViews(current => {
                const { [next.session]: _, ...rest } = current;
                return ended ? rest : { ...rest, [next.session]: next };
            })
        });
        report.current = events.report;
        return () => events.close();
    }, []);

    // What the canvas shows, for the agent sessions' ide_context.
    useEffect(() => {
        report.current({ selection: selected, view: { ...view }, watching });
    }, [selected, view, watching]);

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
    const selectedChange = element ? canvasChanges?.changes.find(c => c.qn === element) : undefined;

    /** A changed element the host's panels ask for: its text diff in the host's diff view (#12). */
    const textDiff = (qn: string) => {
        const change = canvasChanges?.changes.find(c => c.qn === qn);
        if (!change || !snapshot) return;
        // live changes compare with the baseline, not a chosen commit: the host's Changes panel shows that file's diff
        if (marking) openTextDiff(elementTextDiff(change, marking, snapshot).request);
        else host?.showPanel?.('changes');
    };

    const select = useCallback((qn: string) => setSelected(qn), []);

    /** Opens an element's source in the host's editor (on the user's request; the canvas selection stays here). */
    const openSource = host?.openSource && ((qn: string) => {
        const location = snapshot?.locations[qn];
        if (location) host.openSource!(location);
    });

    /** Opens a model file at a line in the host's editor, where it offers one. */
    const openFile = (path: string, line?: number) => {
        const file = snapshot?.files.find(f => f.path === path);
        if (!file || !host?.openSource) return;
        const offset = line ? lineOffset(file.text, line) : 0;
        host.openSource({ uri: file.uri, start: offset, end: offset });
    };

    // the Appling extension's CodeLens: from code back to its element
    const selectRef = useRef(select);
    selectRef.current = select;
    useEffect(() => { host?.onCodeElement?.(qn => selectRef.current(qn)); }, []);

    // The actions of agent sessions (ide_act): open and reveal select, highlight marks elements on the canvas.
    act.current = (a: SessionAct) => {
        if (a.action === 'highlight') setHighlights(current => ({ ...current, [a.session]: a.elements ?? [] }));
        if ((a.action === 'open' || a.action === 'reveal') && a.elements?.[0]) select(a.elements[0]);
        else if (a.action === 'open' && a.file) openFile(a.file, a.line);
    };

    const sessionMarks = useMemo(() => {
        const repo = snapshot && decodeURIComponent(snapshot.root.replace('file://', ''));
        return sessions.filter(s => s.repo === repo).flatMap(s => [...s.claims.elements, ...highlights[s.id] ?? []].map((element): SessionMark => ({ element, color: s.color, label: s.label ?? s.name, session: s.id })));
    }, [sessions, highlights, snapshot]);

    // The host's side panels: what they show, sent after the changes settle, and what they ask.
    useEffect(() => {
        if (!snapshot || !host?.panels) return;
        const timer = setTimeout(() => host.panels!({
            snapshot: { ...snapshot, files: snapshot.files.map(({ uri, path }) => ({ uri, path })) },
            selected, live, sessions,
            review: { on: reviewing, rev, marked, revisions, result: review && (review.ok ? { ok: true, commit: review.commit, diff: review.diff, files: review.files } : review) }
        }), 50);
        return () => clearTimeout(timer);
    }, [snapshot, selected, live, sessions, reviewing, rev, marked, revisions, review]);
    const panelAction = useRef<(action: PanelAction) => void>(() => undefined);
    panelAction.current = action => {
        switch (action.type) {
            case 'select': return select(action.qn);
            case 'textDiff': return textDiff(action.qn);
            case 'review':
                if (action.on !== undefined) setReviewing(action.on);
                if (action.rev !== undefined && action.rev !== rev) { setReview(undefined); setRev(action.rev); }
                if (action.marked !== undefined) setMarked(action.marked);
        }
    };
    useEffect(() => { host?.onPanelAction?.(action => panelAction.current(action)); }, []);

    if (!snapshot || !index || !canvasIndex) return <div className="loading">Loading the model</div>;
    const block = release && `since_v${release.version.replaceAll('.', '_')}`;
    const pending = block ? snapshot.graph.nodes.filter(n => n.kind === 'Migration' && n.qn.endsWith(`.${block}`)) : [];
    const steps = pending.reduce((count, m) => count + ((m.props.steps as string[] | undefined)?.length ?? 0), 0);
    const watched = watching ? agentViews[watching] : undefined;
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
            </header>
            <main className="canvas-area">
                {watched?.show
                    ? <AgentCanvas key={watched.session} index={canvasIndex} view={watched} session={sessions.find(s => s.id === watched.session)} settings={view} selected={element} changes={canvasChanges} onSelect={select} onClose={() => setWatching(undefined)} onOpenFile={openFile} />
                    : <ModelCanvas index={canvasIndex} changes={canvasChanges} name={decodeURIComponent(snapshot.root).split('/').pop()} selected={element} settings={view} sessions={sessionMarks} onSession={host?.focusSession} implementation={snapshot.implementation} buttons={[{ label: openTasks ? `Tasks ${openTasks}` : 'Tasks', pressed: board, run: () => setBoard(!board) }]} onSelect={select} onSettings={next => { setView(next); saveView(next); }} />}
                {board && !watched?.show && <TaskBoard tasks={snapshot.tasks} sessions={sessions} selected={element} onSelect={select} onClose={() => setBoard(false)} />}
                <AgentStrip views={Object.values(agentViews)} sessions={sessions} watching={watching} onWatch={setWatching} />
                {element && !host?.panels && (
                    <Inspector index={index} qn={element} anchor={anchor} change={selectedChange} onSelect={select} onOpenSource={openSource} onClose={() => setSelected(undefined)} />
                )}
            </main>
        </div>
    );
}

function lineOffset(text: string, line: number): number {
    let offset = 0;
    for (let i = 1; i < line && offset >= 0; i++) offset = text.indexOf('\n', offset) + 1 || text.length;
    return offset;
}

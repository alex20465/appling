import { useEffect, useMemo, useRef, useState } from 'react';
import type { Graph } from '@appling/model';
import { FileLink } from '../canvas/Bubble.js';
import { CardCanvas, FlowCanvas, ModelCanvas } from '../canvas/index.js';
import { nextShow, type Bubble, type HostMessage, type Review, type Show, type WindowMessage } from '../protocol.js';
import { cardView, DEFAULT_VIEW, flowView, GraphIndex, kindLabel, lensOf, memberText, relations, trailOf, viewFor, type ViewSettings } from '../views.js';

interface Message {
    from: 'you' | 'claude';
    text: string;
}

const MEMBERS = new Set(['Field', 'Param', 'EnumLiteral', 'ProjectionField']);

/** The floating window: the view Claude shows, the selected element, questions to Claude and proposals to decide. */
export function Window() {
    const [graph, setGraph] = useState<Graph>();
    const [show, setShow] = useState<Show>();
    const [bubbles, setBubbles] = useState<Bubble[]>([]);
    /** The bubble on the canvas; without a pick the latest, so the canvas follows Claude's explanation. */
    const [picked, setPicked] = useState<number>();
    const [selected, setSelected] = useState<string>();
    const [settings, setSettings] = useState<ViewSettings>(DEFAULT_VIEW);
    const [thread, setThread] = useState<Message[]>([]);
    const [reviews, setReviews] = useState<{ id: string, review: Review }[]>([]);
    const [connected, setConnected] = useState(true);
    const socket = useRef<WebSocket>(undefined);
    /** The view on screen, for the socket handler. */
    const shown = useRef<Show>(undefined);

    useEffect(() => {
        const ws = new WebSocket(`ws://${location.host}/events${location.search}`);
        socket.current = ws;
        ws.onclose = () => setConnected(false);
        ws.onmessage = event => {
            const message = JSON.parse(event.data) as HostMessage;
            if (message.type === 'graph') setGraph(message.graph);
            if (message.type === 'show') {
                setSelected(undefined);
                view(message.show);
            }
            if (message.type === 'bubble') {
                setBubbles(current => [...current, message.bubble]);
                setPicked(undefined);
            }
            if (message.type === 'reply') setThread(current => [...current, { from: 'claude', text: message.text }]);
            if (message.type === 'review') setReviews(current => [...current.filter(r => r.id !== message.id), { id: message.id, review: message.review }]);
            if (message.type === 'reviewed') setReviews(current => current.filter(r => r.id !== message.id));
        };
        return () => ws.close();
    }, []);

    const send = (message: WindowMessage) => socket.current?.send(JSON.stringify(message));
    const index = useMemo(() => graph && new GraphIndex(graph), [graph]);
    const cards = useMemo(() => index && (show?.view === 'action' || show?.view === 'event') ? cardView(index, show.view, show.focus) : undefined, [index, show]);
    const flow = useMemo(() => index && (show?.view === 'machine' || show?.view === 'usecase') ? flowView(index, show.view, show.focus) : undefined, [index, show]);
    const openFile = (file: string, line: number) => send({ type: 'open', file, line });
    const current = picked ?? bubbles.length - 1;
    const shownBubbles = bubbles.slice(current, current + 1);
    const step = { at: current, of: bubbles.length, onBack: () => setPicked(current - 1), onNext: () => setPicked(current + 1) };

    /** Each bubble shown, by Claude or by back and next, selects the element it is about. */
    useEffect(() => {
        const target = bubbles[current]?.target;
        if (show && index?.nodes.has(target)) select(target);
    }, [current, bubbles.length]);

    /** Shows the next view; the bubbles go with the view they were placed on. */
    function view(next: Show): Show {
        const { show, keep } = nextShow(shown.current, next);
        shown.current = show;
        setShow(show);
        if (!keep) {
            setBubbles([]);
            setPicked(undefined);
        }
        return show;
    }

    /** A node the lens of the tree cannot draw switches to the lens of its kind. */
    useEffect(() => {
        const last = show?.view === 'node' && show.focus.at(-1);
        if (!index || !last || trailOf(index, settings, show.focus).ids.at(-1)) return;
        const lens = lensOf(index.nodes.get(index.declaration(last))?.kind ?? '');
        if (lens) setSettings({ ...settings, lens });
    }, [index, show]);

    const select = (qn: string, next = show!) => {
        setSelected(qn);
        send({ type: 'select', qn, view: next });
    };

    /** Draws a related element in its own view when it has one, and selects it. */
    const open = (qn: string) => {
        const kind = viewFor(index?.nodes.get(qn)?.kind ?? '');
        select(qn, kind ? view({ view: kind, focus: [qn] }) : show!);
    };

    return (
        <div className="window">
            <header className="window-bar">
                <strong>{show?.title ?? 'Appling'}</strong>
                {!connected && <span className="errors-text">disconnected</span>}
                <button className="close" aria-label="Close" onClick={() => window.close()}>×</button>
            </header>
            {show?.note && <p className="note">{show.note}</p>}
            {bubbles.length > 0 && (
                <nav className="bubble-tabs" aria-label="Bubbles">
                    <button aria-label="Previous bubble" disabled={current === 0} onClick={() => setPicked(current - 1)}>‹</button>
                    {bubbles.map((bubble, i) => (
                        <button key={i} className={i === current ? 'active' : ''} title={bubble.text} onClick={() => setPicked(i)}>
                            {i + 1} {bubble.target.split('.').at(-1)}
                        </button>
                    ))}
                    <button aria-label="Next bubble" disabled={current === bubbles.length - 1} onClick={() => setPicked(current + 1)}>›</button>
                </nav>
            )}
            <main className="window-canvas">
                {!index || !show ? <div className="loading">Waiting for Claude</div>
                    : cards ? <CardCanvas index={index} cards={cards} selected={selected} bubbles={shownBubbles} step={step} onSelect={select} onOpenFile={openFile} />
                    : flow ? <FlowCanvas index={index} flow={flow} selected={selected} bubbles={shownBubbles} step={step} edgesOnClick={show.view === 'machine'} onSelect={select} onOpenFile={openFile} />
                    : <ModelCanvas index={index} focus={show.focus} selected={selected} settings={settings} bubbles={shownBubbles} step={step} onSelect={select} onSettings={setSettings} onOpenFile={openFile} />}
            </main>
            <section className="dock">
                {reviews.map(({ id, review }) => <ReviewCard key={id} review={review} onDecide={decision => send({ type: 'decide', id, decision })} onOpenFile={openFile} />)}
                {index && selected && <Details index={index} qn={selected} onOpen={open} />}
                <div className="thread">
                    {thread.length === 0 && <p className="muted">Ask Claude about what you see. Questions reach a Claude Code session started with --dangerously-load-development-channels server:appling.</p>}
                    {thread.map((message, i) => <p key={i} className={`message message-${message.from}`}><Linked text={message.text} onOpenFile={openFile} /></p>)}
                </div>
            </section>
            <Ask onAsk={text => {
                setThread(current => [...current, { from: 'you', text }]);
                send({ type: 'ask', text });
            }} />
        </div>
    );
}

function Details({ index, qn, onOpen }: { index: GraphIndex, qn: string, onOpen(qn: string): void }) {
    const node = index.nodes.get(qn);
    if (!node) return null;
    const members = index.children(qn).filter(m => MEMBERS.has(m.kind)).map(m => memberText(m, index));
    const related = new Set([...relations(index, qn, 'uses').values(), ...relations(index, qn, 'usedBy').values()].flat().map(r => r.qn));
    return (
        <div className="details">
            <div><span className="entity-tag">{kindLabel(node.kind)}</span> <strong>{qn}</strong></div>
            {members.length > 0 && <div className="details-members">{members.join(' · ')}</div>}
            {related.size > 0 && <div className="chips">{[...related].map(r => <button key={r} className="chip" onClick={() => onOpen(r)}>{r}</button>)}</div>}
        </div>
    );
}

function ReviewCard({ review, onDecide, onOpenFile }: { review: Review, onDecide(decision: { accepted: true } | { accepted: false, comment?: string }): void, onOpenFile(file: string, line: number): void }) {
    const [comment, setComment] = useState('');
    const { added, removed, changed } = review.graph;
    return (
        <div className="proposal">
            <strong>Proposed change</strong>
            <p>{review.summary}</p>
            {review.hunks.map((hunk, i) => (
                <pre key={i} className="hunk">
                    <div className="hunk-file"><FileLink file={hunk.file} line={hunk.line} onOpenFile={onOpenFile} /></div>
                    {hunk.removed.map((line, j) => <div key={`r${j}`} className="removed">- {line}</div>)}
                    {hunk.added.map((line, j) => <div key={`a${j}`} className="added">+ {line}</div>)}
                </pre>
            ))}
            <p className="graph-changes">
                {added.map(qn => <span key={qn} className="added">+ {qn}</span>)}
                {removed.map(qn => <span key={qn} className="removed">- {qn}</span>)}
                {changed.map(qn => <span key={qn}>~ {qn}</span>)}
            </p>
            <input placeholder="Comment for Claude (optional)" value={comment} onChange={e => setComment(e.target.value)} />
            <div className="proposal-actions">
                <button className="button" onClick={() => onDecide({ accepted: true })}>Accept</button>
                <button className="button" onClick={() => onDecide({ accepted: false, comment: comment.trim() || undefined })}>Reject</button>
            </div>
        </div>
    );
}

/** Text with every file reference, such as `shop/models.py:14`, as a link that opens the file at that line. */
function Linked({ text, onOpenFile }: { text: string, onOpenFile(file: string, line: number): void }) {
    const parts = text.split(/([\w./-]+\.\w+:\d+)/);
    return parts.map((part, i) => {
        if (i % 2 === 0) return part;
        const at = part.lastIndexOf(':');
        return <FileLink key={i} file={part.slice(0, at)} line={Number(part.slice(at + 1))} onOpenFile={onOpenFile} />;
    });
}

function Ask({ onAsk }: { onAsk(text: string): void }) {
    const [draft, setDraft] = useState('');
    const submit = () => {
        if (!draft.trim()) return;
        onAsk(draft.trim());
        setDraft('');
    };
    return (
        <form className="ask" onSubmit={e => { e.preventDefault(); submit(); }}>
            <input placeholder="Ask Claude about this" value={draft} onChange={e => setDraft(e.target.value)} />
            <button className="button" type="submit" disabled={!draft.trim()}>Ask</button>
        </form>
    );
}

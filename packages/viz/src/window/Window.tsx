import { useEffect, useMemo, useRef, useState } from 'react';
import type { Graph } from '@appling/model';
import { CardCanvas, EntityCanvas } from '../canvas/index.js';
import type { HostMessage, Review, Show, WindowMessage } from '../protocol.js';
import { cardView, DEFAULT_VIEW, GraphIndex, kindLabel, memberText, relations, viewFor, type ViewSettings } from '../views.js';

interface Message {
    from: 'you' | 'claude';
    text: string;
}

const MEMBERS = new Set(['Field', 'Param', 'EnumLiteral', 'ProjectionField']);

/** The floating window: the view Claude shows, the selected element, questions to Claude and proposals to decide. */
export function Window() {
    const [graph, setGraph] = useState<Graph>();
    const [show, setShow] = useState<Show>();
    const [selected, setSelected] = useState<string>();
    const [settings, setSettings] = useState<ViewSettings>(DEFAULT_VIEW);
    const [thread, setThread] = useState<Message[]>([]);
    const [reviews, setReviews] = useState<{ id: string, review: Review }[]>([]);
    const [connected, setConnected] = useState(true);
    const socket = useRef<WebSocket>(undefined);

    useEffect(() => {
        const ws = new WebSocket(`ws://${location.host}/events${location.search}`);
        socket.current = ws;
        ws.onclose = () => setConnected(false);
        ws.onmessage = event => {
            const message = JSON.parse(event.data) as HostMessage;
            if (message.type === 'graph') setGraph(message.graph);
            if (message.type === 'show') {
                setShow(message.show);
                setSelected(undefined);
            }
            if (message.type === 'reply') setThread(current => [...current, { from: 'claude', text: message.text }]);
            if (message.type === 'review') setReviews(current => [...current.filter(r => r.id !== message.id), { id: message.id, review: message.review }]);
            if (message.type === 'reviewed') setReviews(current => current.filter(r => r.id !== message.id));
        };
        return () => ws.close();
    }, []);

    const send = (message: WindowMessage) => socket.current?.send(JSON.stringify(message));
    const index = useMemo(() => graph && new GraphIndex(graph), [graph]);
    const cards = useMemo(() => index && show && show.view !== 'entities' ? cardView(index, show.view, show.focus) : undefined, [index, show]);

    const select = (qn: string, view = show!) => {
        setSelected(qn);
        send({ type: 'select', qn, view });
    };

    /** Draws a related element in its own view when it has one, and selects it. */
    const open = (qn: string) => {
        const view = viewFor(index?.nodes.get(qn)?.kind ?? '');
        const next = view ? { view, focus: [qn] } : show!;
        if (view) setShow(next);
        select(qn, next);
    };

    return (
        <div className="window">
            <header className="window-bar">
                <strong>{show?.title ?? 'Appling'}</strong>
                {!connected && <span className="errors-text">disconnected</span>}
                <button className="close" aria-label="Close" onClick={() => window.close()}>×</button>
            </header>
            {show?.note && <p className="note">{show.note}</p>}
            <main className="window-canvas">
                {!index || !show ? <div className="loading">Waiting for Claude</div>
                    : cards ? <CardCanvas cards={cards} selected={selected} onSelect={select} />
                    : <EntityCanvas index={index} focus={show.focus} selected={selected} settings={settings} onSelect={select} onSettings={setSettings} />}
            </main>
            <section className="dock">
                {reviews.map(({ id, review }) => <ReviewCard key={id} review={review} onDecide={decision => send({ type: 'decide', id, decision })} />)}
                {index && selected && <Details index={index} qn={selected} onOpen={open} />}
                <div className="thread">
                    {thread.length === 0 && <p className="muted">Ask Claude about what you see. Questions reach a Claude Code session started with --dangerously-load-development-channels server:appling.</p>}
                    {thread.map((message, i) => <p key={i} className={`message message-${message.from}`}>{message.text}</p>)}
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

function ReviewCard({ review, onDecide }: { review: Review, onDecide(decision: { accepted: true } | { accepted: false, comment?: string }): void }) {
    const [comment, setComment] = useState('');
    const { added, removed, changed } = review.graph;
    return (
        <div className="proposal">
            <strong>Proposed change</strong>
            <p>{review.summary}</p>
            {review.hunks.map((hunk, i) => (
                <pre key={i} className="hunk">
                    <div className="hunk-file">{hunk.file}:{hunk.line}</div>
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

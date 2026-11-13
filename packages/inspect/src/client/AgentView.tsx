import { useEffect, useMemo, useState } from 'react';
import type { AgentSession } from '@appling/ai';
import { CardCanvas, FlowCanvas, ModelCanvas } from '@appling/viz/canvas';
import { cardView, flowView, lensOf, trailOf, type GraphIndex, type MarkedChanges, type ViewSettings } from '@appling/viz/views';
import type { AgentView } from '../shared/live.js';
import { askSession } from './api.js';

/**
 * The views agent sessions drew with the visual tools, as a strip over the canvas. Nothing moves until the user opens
 * one; then the canvas shows it and follows its next views and bubbles, until the user goes back to the model.
 */
export function AgentStrip({ views, sessions, watching, onWatch }: { views: AgentView[], sessions: AgentSession[], watching?: string, onWatch(session?: string): void }) {
    const shown = views.filter(v => v.show || v.steps.length || v.replies.length).sort((a, b) => b.at.localeCompare(a.at));
    if (!shown.length || watching) return null;
    const byId = new Map(sessions.map(s => [s.id, s]));
    return (
        <div className="agent-strip" aria-label="Agent views">
            {shown.map(view => {
                const session = byId.get(view.session);
                const step = view.steps.at(-1);
                return (
                    <button key={view.session} className="agent-chip" disabled={!view.show} onClick={() => onWatch(view.session)} title={view.replies.at(-1) ?? view.show?.note ?? ''}>
                        <span className="session-dot" style={{ background: session?.color }} />
                        <span className="agent-chip-name">{session ? session.label ?? session.name : 'session'}</span>
                        <span className="muted">
                            {view.show ? ` shows ${view.show.title ?? view.show.focus.at(-1)}` : ''}
                            {view.bubbles.length ? ` · ${view.bubbles.length} note${view.bubbles.length > 1 ? 's' : ''}` : ''}
                            {step ? ` · ${step.text}${step.total ? ` ${step.done ?? 0}/${step.total}` : ''}` : ''}
                        </span>
                    </button>
                );
            })}
        </div>
    );
}

interface AgentCanvasProps {
    index: GraphIndex;
    view: AgentView;
    session?: AgentSession;
    settings: ViewSettings;
    selected?: string;
    changes?: MarkedChanges;
    /** The bubble on screen, and whether the view lists its bubbles itself (a host with panels lists a playbook's steps). */
    at: number;
    list: boolean;
    onStep(at: number): void;
    onSelect(qn: string): void;
    onClose(): void;
    onOpenFile?(file: string, line: number): void;
}

/** One session's view on the canvas: its trail, flowchart or cards, its bubbles one at a time, its last step and reply. */
export function AgentCanvas({ index, view, session, settings: base, selected, changes, at, list, onStep, onSelect, onClose, onOpenFile }: AgentCanvasProps) {
    // every push of the session sends the view anew
    const show = useMemo(() => view.show!, [JSON.stringify(view.show)]);
    const current = Math.min(at, Math.max(0, view.bubbles.length - 1));
    const step = { at: current, of: view.bubbles.length, onBack: () => onStep(current - 1), onNext: () => onStep(current + 1) };
    const bubbles = view.bubbles.slice(current, current + 1);
    const target = bubbles[0]?.target;
    const cards = useMemo(() => show.view === 'action' || show.view === 'event' ? cardView(index, show.view, show.focus) : undefined, [index, show]);
    const flow = useMemo(() => show.view === 'machine' || show.view === 'usecase' ? flowView(index, show.view, show.focus) : undefined, [index, show]);
    /** A playbook's tree grows with each step played. */
    const focus = useMemo(() => view.playbook ? show.focus.slice(0, current + 1) : show.focus, [show, view.playbook, current]);

    /** The shown bubble selects its element, so the inspector shows it. */
    useEffect(() => { if (target) onSelect(target); }, [current, target]);

    /**
     * The tree shows the element of the shown bubble under the lens of its kind; without bubbles, a last node the lens
     * cannot draw switches to the lens of its kind. The lens the person picks holds until the next bubble.
     */
    const lens = useMemo(() => {
        const of = (qn: string) => lensOf(index.nodes.get(index.declaration(qn))?.kind ?? '');
        const last = show.focus.at(-1);
        if (show.view !== 'node') return base.lens;
        if (target) return of(target) ?? base.lens;
        return last && !trailOf(index, base, show.focus).ids.at(-1) ? of(last) ?? base.lens : base.lens;
    }, [index, show, target, base]);
    const [picked, setPicked] = useState<{ at: string, settings: ViewSettings }>();
    const here = `${current} ${target}`;
    const settings = useMemo(() => picked?.at === here ? picked.settings : { ...base, lens }, [picked, here, base, lens]);

    const latest = view.steps.at(-1);
    return (
        <div className="agent-canvas">
            <div className="agent-bar" style={{ '--session': session?.color } as React.CSSProperties}>
                <span className="session-dot" style={{ background: session?.color }} />
                <strong>{show.title ?? (session ? session.label ?? session.name : 'Agent view')}</strong>
                {show.note && <span className="muted agent-note">{show.note}</span>}
                {latest && <span className="agent-step" role="status">{latest.text}{latest.total ? ` ${latest.done ?? 0}/${latest.total}` : ''}</span>}
                <button className="button" onClick={onClose}>Back to the model</button>
            </div>
            <AskSession session={view.session} name={session ? session.label ?? session.name : 'the session'} asked={view.questions?.at(-1)} />
            {view.replies.length > 0 && <p className="agent-reply">{view.replies.at(-1)}</p>}
            {list && view.bubbles.length > 1 && (
                <ol className="agent-steps" aria-label="Steps">
                    {view.bubbles.map((bubble, i) => (
                        <li key={i}><button aria-current={i === current ? 'step' : undefined} title={bubble.text} onClick={() => onStep(i)}>{i + 1} {bubble.title ?? bubble.target.split('.').at(-1)}</button></li>
                    ))}
                </ol>
            )}
            {cards ? <CardCanvas index={index} cards={cards} selected={selected} bubbles={bubbles} step={step} onSelect={onSelect} onOpenFile={onOpenFile} />
                : flow ? <FlowCanvas index={index} flow={flow} selected={selected} bubbles={bubbles} step={step} edgesOnClick={show.view === 'machine'} onSelect={onSelect} onOpenFile={onOpenFile} />
                : <ModelCanvas index={index} focus={focus} folded={view.playbook} selected={selected} settings={settings} bubbles={bubbles} changes={changes} step={step} onSelect={onSelect} onSettings={next => setPicked({ at: here, settings: next })} onOpenFile={onOpenFile} />}
        </div>
    );
}

/** A question to the session about its view: it reaches the session's inbox, the answer comes back with visual_reply. */
function AskSession({ session, name, asked }: { session: string, name: string, asked?: string }) {
    const [text, setText] = useState('');
    const [error, setError] = useState<string>();
    const [sending, setSending] = useState(false);
    const submit = async (event: React.FormEvent) => {
        event.preventDefault();
        const question = text.trim();
        if (!question || sending) return;
        setSending(true);
        try {
            await askSession(session, question);
            setText('');
            setError(undefined);
        } catch (failure) {
            setError((failure as Error).message);
        } finally {
            setSending(false);
        }
    };
    return (
        <form className="agent-ask" onSubmit={submit}>
            {asked && <span className="muted agent-asked" title={asked}>You asked: {asked}</span>}
            <input aria-label={`Ask ${name}`} placeholder={`Ask ${name} about this view`} value={text} onChange={event => setText(event.target.value)} />
            <button className="button" type="submit" disabled={!text.trim() || sending}>Ask</button>
            {error && <span className="agent-ask-error" role="alert">{error}</span>}
        </form>
    );
}

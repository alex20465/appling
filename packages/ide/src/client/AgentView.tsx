import { useEffect, useMemo, useState } from 'react';
import type { AgentSession } from '@appling/ai';
import { CardCanvas, FlowCanvas, ModelCanvas } from '@appling/viz/canvas';
import { cardView, flowView, lensOf, trailOf, type GraphIndex, type MarkedChanges, type ViewSettings } from '@appling/viz/views';
import type { AgentView } from '../shared/live.js';

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
    onSelect(qn: string): void;
    onClose(): void;
    onOpenFile?(file: string, line: number): void;
}

/** One session's view on the canvas: its trail, flowchart or cards, its bubbles one at a time, its last step and reply. */
export function AgentCanvas({ index, view, session, settings: base, selected, changes, onSelect, onClose, onOpenFile }: AgentCanvasProps) {
    const show = view.show!;
    const [settings, setSettings] = useState(base);
    const [picked, setPicked] = useState<number>();
    const current = Math.min(picked ?? 0, Math.max(0, view.bubbles.length - 1));
    const step = { at: current, of: view.bubbles.length, onBack: () => setPicked(current - 1), onNext: () => setPicked(current + 1) };
    const bubbles = view.bubbles.slice(current, current + 1);
    const cards = useMemo(() => show.view === 'action' || show.view === 'event' ? cardView(index, show.view, show.focus) : undefined, [index, show]);
    const flow = useMemo(() => show.view === 'machine' || show.view === 'usecase' ? flowView(index, show.view, show.focus) : undefined, [index, show]);

    // A new view starts at its first bubble.
    useEffect(() => setPicked(undefined), [show]);

    /** A node the lens cannot draw switches to the lens of its kind, for this view only. */
    useEffect(() => {
        const last = show.view === 'node' && show.focus.at(-1);
        if (!last || trailOf(index, settings, show.focus).ids.at(-1)) return;
        const lens = lensOf(index.nodes.get(index.declaration(last))?.kind ?? '');
        if (lens) setSettings({ ...settings, lens });
    }, [index, show]);

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
            {view.replies.length > 0 && <p className="agent-reply">{view.replies.at(-1)}</p>}
            {cards ? <CardCanvas index={index} cards={cards} selected={selected} bubbles={bubbles} step={step} onSelect={onSelect} onOpenFile={onOpenFile} />
                : flow ? <FlowCanvas index={index} flow={flow} selected={selected} bubbles={bubbles} step={step} edgesOnClick={show.view === 'machine'} onSelect={onSelect} onOpenFile={onOpenFile} />
                : <ModelCanvas index={index} focus={show.focus} selected={selected} settings={settings} bubbles={bubbles} changes={changes} step={step} onSelect={onSelect} onSettings={setSettings} onOpenFile={onOpenFile} />}
        </div>
    );
}

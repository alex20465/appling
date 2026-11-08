import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentSession, Chapter, Playbook, PlaybookPosition, ResponseKind } from '@appling/ai';
import { ModelCanvas } from '@appling/viz/canvas';
import { lensOf, trailOf, type GraphIndex, type ViewSettings } from '@appling/viz/views';
import { back, canForward, forward, isUnwatched, queued, stepDuration, stepView } from '../shared/player.js';

const CHANGE: Record<string, string> = { add: 'adds', change: 'changes', remove: 'removes', show: 'shows' };

interface PanelProps {
    playbook?: Playbook;
    sessions: AgentSession[];
    playing: boolean;
    onPlay(position: PlaybookPosition): void;
    onSession(chapter: Chapter): void;
    onDiff(chapter: Chapter): void;
}

/**
 * The playbook beside the canvas (#19): every chapter of the workspace's sessions in order, with its session's colour
 * and label, its steps done of planned, and whether it is still unwatched. Play starts where the user is.
 */
export function PlaybookPanel({ playbook, sessions, playing, onPlay, onSession, onDiff }: PanelProps) {
    const chapters = playbook?.chapters ?? [];
    const live = new Set(sessions.map(s => s.id));
    const position = playbook?.position ?? { step: 0 };
    return (
        <div className="review playbook">
            <h3>Playbook</h3>
            {!chapters.length && <p className="muted">No chapters yet. Agent sessions open a chapter with their plan when they start a piece of work; you step through it here and on the canvas, and respond to each step.</p>}
            {chapters.length > 0 && !playing && (
                <p className="review-summary">
                    <button className="button" onClick={() => onPlay(position.chapter ? position : forward(playbook!, position))}>{position.chapter ? 'Resume' : 'Play'}</button>
                    {' '}<span className="muted">{chapters.filter(isUnwatched).length} unwatched</span>
                </p>
            )}
            <ol className="chapters">
                {chapters.map(chapter => {
                    const done = chapter.steps.filter(s => s.state === 'done').length;
                    const here = chapter.id === position.chapter;
                    return (
                        <li key={chapter.id} className={`chapter${here ? ' here' : ''}${isUnwatched(chapter) ? ' unwatched' : ''}`} style={{ '--session': chapter.color } as React.CSSProperties}>
                            <button className="result" onClick={() => onPlay({ chapter: chapter.id, step: here ? position.step : 0 })} title={chapter.plan}>
                                <span><span className="session-dot" style={{ background: chapter.color }} /> {chapter.title}</span>
                                <span className="muted">{done}/{chapter.steps.length}{chapter.status === 'closed' ? ' · closed' : ''}</span>
                            </button>
                            <div className="chapter-meta muted">
                                {chapter.label}{chapter.refs.length ? ` · builds on ${chapter.refs.map(r => chapters.find(c => c.id === r)?.title ?? 'an earlier chapter').join(', ')}` : ''}
                                {' · '}<button className="link" onClick={() => onPlay({ chapter: chapter.id, step: 0 })}>replay</button>
                                {chapter.session && live.has(chapter.session) && <> · <button className="link" onClick={() => onSession(chapter)}>session</button></>}
                                {chapter.session && <> · <button className="link" onClick={() => onDiff(chapter)}>diff</button></>}
                            </div>
                            {chapter.result && <p className="chapter-result">{chapter.result}</p>}
                        </li>
                    );
                })}
            </ol>
        </div>
    );
}

interface PlayerProps {
    index: GraphIndex;
    playbook: Playbook;
    settings: ViewSettings;
    selected?: string;
    repo: string;
    onMove(position: PlaybookPosition): void;
    onRespond(chapter: string, step: number, kind: ResponseKind, text?: string): Promise<void>;
    onSelect(qn: string): void;
    onClose(): void;
    onSession(chapter: Chapter): void;
    onDiff(chapter: Chapter): void;
}

/**
 * The playbook on the canvas: the watched chapter's trail up to the current step, its added, changed and removed
 * elements marked (dashed while planned) and played once more on every step. The user's back and forward move it, and
 * playing (from Play or Replay, until the chapter's end or Pause) moves it one `stepDuration` per step; chapters that
 * arrive meanwhile wait in the queue.
 */
export function PlaybookPlayer({ index, playbook, settings: base, selected, repo, onMove, onRespond, onSelect, onClose, onSession, onDiff }: PlayerProps) {
    const position = playbook.position;
    const view = useMemo(() => stepView(playbook, position), [playbook, position.chapter, position.step]);
    const [settings, setSettings] = useState(base);
    const [comment, setComment] = useState('');
    const [sent, setSent] = useState<string>();
    const waiting = queued(playbook, position);
    /**
     * Playing steps forward on its own, one `stepDuration` per step once the canvas has grown the step's elements, to
     * the chapter's end; typing a comment holds it.
     */
    const [auto, setAuto] = useState(true);
    const [grown, setGrown] = useState<string>();
    const at = `${position.chapter} ${position.step}`;
    const [left, setLeft] = useState<number>();
    const latest = useRef({ playbook, onMove });
    latest.current = { playbook, onMove };
    const duration = view ? stepDuration(view) : 0;
    const end = !view || position.step >= view.chapter.steps.length;
    const advancing = auto && !end && !comment && grown === at;
    useEffect(() => {
        setLeft(undefined);
        if (!advancing) return;
        const due = Date.now() + duration;
        setLeft(duration);
        const tick = setInterval(() => {
            const rest = due - Date.now();
            if (rest > 0) return setLeft(rest);
            clearInterval(tick);
            latest.current.onMove(forward(latest.current.playbook, position));
        }, 100);
        return () => clearInterval(tick);
    }, [advancing, position.chapter, position.step, duration]);
    useEffect(() => { if (end) setAuto(false); }, [end]);
    const toggle = () => {
        if (auto) return setAuto(false);
        if (end && view) onMove({ chapter: view.chapter.id, step: 0 });
        setAuto(true);
    };
    const elsewhere = view && view.chapter.repo !== repo;
    // Elements this canvas does not have (another repo's, or removed and gone) are left out of the trail.
    // Keyed by its text, so a playbook change elsewhere (a chapter queued, a step marked done) never replants the tree.
    const focusKey = view?.focus.filter(qn => index.nodes.has(qn)).join('\n');
    const focus = useMemo(() => focusKey ? focusKey.split('\n') : undefined, [focusKey]);

    useEffect(() => { setComment(''); setSent(undefined); }, [position.chapter, position.step]);

    /** A step whose elements the lens cannot draw switches to the lens of their kind, for the player only. */
    useEffect(() => {
        const last = focus?.at(-1);
        if (!last || trailOf(index, settings, [last]).ids.at(-1)) return;
        const lens = lensOf(index.nodes.get(index.declaration(last))?.kind ?? '');
        if (lens) setSettings({ ...settings, lens });
    }, [index, focus]);

    // Arrow keys step, like a slide show.
    useEffect(() => {
        const key = (event: KeyboardEvent) => {
            if ((event.target as HTMLElement)?.closest('input, textarea, .monaco-editor')) return;
            if (event.key === 'ArrowRight' && canForward(playbook, position)) onMove(forward(playbook, position));
            if (event.key === 'ArrowLeft') onMove(back(playbook, position));
        };
        addEventListener('keydown', key);
        return () => removeEventListener('keydown', key);
    }, [playbook, position.chapter, position.step]);

    if (!view) return null;
    const { chapter, step } = view;
    const respond = async (kind: ResponseKind) => {
        if (!step) return;
        await onRespond(chapter.id, step.n, kind, comment.trim() || undefined);
        setComment('');
        setSent(kind === 'approve' ? 'Approved' : kind === 'reject' ? 'Rejected' : 'Comment sent');
    };
    return (
        <div className="agent-canvas player" style={{ '--session': chapter.color } as React.CSSProperties}>
            <div className="agent-bar" style={{ '--session': chapter.color } as React.CSSProperties}>
                <span className="session-dot" style={{ background: chapter.color }} />
                <strong>{chapter.title}</strong>
                <span className="muted agent-note">{chapter.label}{elsewhere ? ` · in ${chapter.repo.split('/').pop()}` : ''}</span>
                <span className="agent-step" role="status">{view.at ? `step ${view.at} of ${chapter.steps.length}` : 'plan'}</span>
                <button className="button" onClick={toggle} aria-pressed={auto}>{auto ? 'Pause' : 'Play'}</button>
                <button className="button" onClick={() => onMove(back(playbook, position))} aria-label="Step back">←</button>
                <button className="button" onClick={() => onMove(forward(playbook, position))} disabled={!canForward(playbook, position)} aria-label="Step forward">→</button>
                <button className="button" onClick={() => { onMove({ chapter: chapter.id, step: 0 }); setAuto(true); }}>Replay</button>
                {chapter.session && <button className="button" onClick={() => onSession(chapter)}>Session</button>}
                {chapter.session && <button className="button" onClick={() => onDiff(chapter)}>Diff</button>}
                <button className="button" onClick={onClose}>Back to the model</button>
            </div>
            <div className="player-progress" role="timer">
                <div style={{ width: left === undefined ? 0 : `${100 - (left / duration) * 100}%` }} />
                <span>{left !== undefined ? `next step in ${Math.ceil(left / 1000)}s` : end ? 'end of the chapter' : comment ? 'held while you write' : !auto ? 'paused' : 'showing the step'}</span>
            </div>
            <div className="player-step">
                {step ? (
                    <>
                        <p>
                            <span className={`step-state ${step.state}`}>{step.state === 'done' ? 'done' : 'planned'}</span>{' '}
                            <span className={`step-change ${step.change}`}>{CHANGE[step.change]}</span>{' '}
                            {step.elements.map(e => <button key={e} className="link" onClick={() => onSelect(e)}>{e}</button>).reduce<React.ReactNode[]>((all, link, i) => i ? [...all, ', ', link] : [link], [])}
                        </p>
                        <p>{step.note}{step.doneNote ? ` · ${step.doneNote}` : ''}</p>
                        {step.responses.length > 0 && <p className="muted">{step.responses.map(r => `${r.kind}${r.text ? `: ${r.text}` : ''}`).join(' · ')}</p>}
                        <div className="proposal-actions">
                            <input className="player-comment" value={comment} onChange={e => setComment(e.target.value)} placeholder="Comment for the session (optional)" onKeyDown={e => { if (e.key === 'Enter' && comment.trim()) respond('comment'); }} />
                            <button className="button" onClick={() => respond('approve')}>Approve</button>
                            <button className="button danger-button" onClick={() => respond('reject')}>Reject</button>
                            <button className="button" onClick={() => respond('comment')} disabled={!comment.trim()}>Comment</button>
                            {sent && <span className="muted" role="status">{sent}{chapter.session ? '' : ' (no session to tell)'}</span>}
                        </div>
                    </>
                ) : (
                    <>
                        <p>{chapter.plan}</p>
                        <p className="muted">{chapter.steps.length} step{chapter.steps.length === 1 ? '' : 's'}, {chapter.steps.filter(s => s.state === 'done').length} done{chapter.status === 'closed' ? ` · ${chapter.result ?? 'closed'}` : ''}</p>
                    </>
                )}
                {waiting.length > 0 && <p className="muted player-queue">Queued next: {waiting.map(c => `${c.title} (${c.label})`).join(', ')}</p>}
            </div>
            <ModelCanvas key={chapter.id} index={index} focus={focus} selected={selected} settings={settings}
                changes={view.changes} beat={view.at} grow onGrown={() => setGrown(at)} onSelect={onSelect} onSettings={setSettings} />
        </div>
    );
}

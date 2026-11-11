import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentSession, Chapter, Playbook, PlaybookPosition } from '@appling/ai';
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
            {!chapters.length && <p className="muted">No chapters yet. Agent sessions open a chapter with their plan when they start a piece of work; you step through it here and on the canvas.</p>}
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
    onSelect(qn: string): void;
    onClose(): void;
    onSession(chapter: Chapter): void;
    onDiff(chapter: Chapter): void;
}

/**
 * The playbook on the canvas: the watched chapter's trail up to the current step, its added, changed and removed
 * elements marked (dashed while planned) and played once more on every step. Below it the step's note as a caption
 * and a control bar as in a video player: back, play, forward, one tick per step to jump to, and replay. The user
 * steps by hand; Play moves one `stepDuration` per step to the chapter's end. Chapters that arrive meanwhile queue.
 */
export function PlaybookPlayer({ index, playbook, settings: base, selected, repo, onMove, onSelect, onClose, onSession, onDiff }: PlayerProps) {
    const position = playbook.position;
    const view = useMemo(() => stepView(playbook, position), [playbook, position.chapter, position.step]);
    const [settings, setSettings] = useState(base);
    const waiting = queued(playbook, position);
    /** Playing steps forward on its own, one `stepDuration` per step once the canvas has grown the step's elements. */
    const [auto, setAuto] = useState(false);
    const [grown, setGrown] = useState<string>();
    const at = `${position.chapter} ${position.step}`;
    const [left, setLeft] = useState<number>();
    const latest = useRef({ playbook, onMove });
    latest.current = { playbook, onMove };
    const duration = view ? stepDuration(view) : 0;
    const end = !view || position.step >= view.chapter.steps.length;
    const advancing = auto && !end && grown === at;
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

    /** A step whose elements the lens cannot draw switches to the lens of their kind, for the player only. */
    useEffect(() => {
        const last = focus?.at(-1);
        if (!last || trailOf(index, settings, [last]).ids.at(-1)) return;
        const lens = lensOf(index.nodes.get(index.declaration(last))?.kind ?? '');
        if (lens) setSettings({ ...settings, lens });
    }, [index, focus]);

    // The arrow keys step and the space bar plays or pauses, as in a video player.
    const play = useRef(toggle);
    play.current = toggle;
    useEffect(() => {
        const key = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            if (target?.closest('input, textarea, .monaco-editor')) return;
            if (event.key === 'ArrowRight' && canForward(playbook, position)) onMove(forward(playbook, position));
            if (event.key === 'ArrowLeft') onMove(back(playbook, position));
            // a focused button takes the space bar itself
            if (event.key === ' ' && !target?.closest('button')) {
                event.preventDefault();
                play.current();
            }
        };
        addEventListener('keydown', key);
        return () => removeEventListener('keydown', key);
    }, [playbook, position.chapter, position.step]);

    if (!view) return null;
    const { chapter, step } = view;
    const status = left !== undefined ? `next step in ${Math.ceil(left / 1000)}s` : end ? 'end of the chapter' : auto ? 'showing the step' : 'paused · → for the next step';
    return (
        <div className="agent-canvas player" style={{ '--session': chapter.color } as React.CSSProperties}>
            <div className="agent-bar">
                <span className="session-dot" style={{ background: chapter.color }} />
                <strong>{chapter.title}</strong>
                <span className="muted agent-note">{chapter.label}{elsewhere ? ` · in ${chapter.repo.split('/').pop()}` : ''}</span>
                <span className="agent-bar-end">
                    {chapter.session && <button className="button" onClick={() => onSession(chapter)}>Session</button>}
                    {chapter.session && <button className="button" onClick={() => onDiff(chapter)}>Diff</button>}
                    <button className="player-icon" onClick={onClose} aria-label="Back to the model" title="Back to the model"><Icon name="close" /></button>
                </span>
            </div>
            <ModelCanvas key={chapter.id} index={index} focus={focus} selected={selected} settings={settings}
                changes={view.changes} beat={view.at} grow onGrown={() => setGrown(at)} onSelect={onSelect} onSettings={setSettings} />
            <div className="player-dock">
                <div className="player-caption">
                    {step ? (
                        <>
                            <p>
                                <span className={`step-state ${step.state}`}>{step.state === 'done' ? 'done' : 'planned'}</span>{' '}
                                <span className={`step-change ${step.change}`}>{CHANGE[step.change]}</span>{' '}
                                {step.elements.map(e => <button key={e} className="link" onClick={() => onSelect(e)}>{e}</button>).reduce<React.ReactNode[]>((all, link, i) => i ? [...all, ', ', link] : [link], [])}
                            </p>
                            <p>{step.note}{step.doneNote ? ` · ${step.doneNote}` : ''}</p>
                        </>
                    ) : (
                        <>
                            <p>{chapter.plan}</p>
                            <p className="muted">{chapter.steps.length} step{chapter.steps.length === 1 ? '' : 's'}, {chapter.steps.filter(s => s.state === 'done').length} done{chapter.status === 'closed' ? ` · ${chapter.result ?? 'closed'}` : ''}</p>
                        </>
                    )}
                    {waiting.length > 0 && <p className="muted player-queue">Queued next: {waiting.map(c => `${c.title} (${c.label})`).join(', ')}</p>}
                </div>
                <div className="player-controls" role="toolbar" aria-label="Playbook player">
                    <button className="player-icon" onClick={() => onMove(back(playbook, position))} aria-label="Step back" title="Step back (←)"><Icon name="back" /></button>
                    <button className="player-icon play" onClick={toggle} aria-pressed={auto} aria-label={auto ? 'Pause' : 'Play'} title={`${auto ? 'Pause' : 'Play'} (space)`}><Icon name={auto ? 'pause' : 'play'} /></button>
                    <button className="player-icon" onClick={() => onMove(forward(playbook, position))} disabled={!canForward(playbook, position)} aria-label="Step forward" title="Step forward (→)"><Icon name="forward" /></button>
                    <ol className="player-track" aria-label="Steps">
                        {Array.from({ length: chapter.steps.length + 1 }, (_, i) => (
                            <li key={i} className={i < view.at ? 'past' : i === view.at ? 'here' : ''}>
                                <button onClick={() => onMove({ chapter: chapter.id, step: i })} aria-label={i ? `Step ${i}` : 'The plan'} title={i ? `${i}. ${chapter.steps[i - 1].note}` : chapter.plan} />
                                {i === view.at && left !== undefined && <span style={{ width: `${100 - (left / duration) * 100}%` }} />}
                            </li>
                        ))}
                    </ol>
                    <span className="player-status" role="status">{view.at ? `step ${view.at} of ${chapter.steps.length}` : 'plan'} · {status}</span>
                    <button className="player-icon" onClick={() => onMove({ chapter: chapter.id, step: 0 })} aria-label="Replay from the plan" title="Replay from the plan"><Icon name="replay" /></button>
                </div>
            </div>
        </div>
    );
}

const ICONS = {
    back: 'M5 4h2v12H5zM16 4v12L8 10z',
    forward: 'M13 4h2v12h-2zM4 4v12l8-6z',
    play: 'M6 4v12l10-6z',
    pause: 'M5 4h3.5v12H5zM11.5 4H15v12h-3.5z',
    replay: 'M10 4a6 6 0 1 1-6 6h2a4 4 0 1 0 4-4v3L5.5 5 10 1z',
    close: 'M5.4 4 10 8.6 14.6 4 16 5.4 11.4 10 16 14.6 14.6 16 10 11.4 5.4 16 4 14.6 8.6 10 4 5.4z'
};

function Icon({ name }: { name: keyof typeof ICONS }) {
    return <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d={ICONS[name]} fill="currentColor" /></svg>;
}

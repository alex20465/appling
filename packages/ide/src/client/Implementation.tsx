import { useMemo, useState } from 'react';
import type { AgentSession } from '@appling/ai';
import type { GenerationEvent, GenerationSelection } from '@appling/codegen';
import { IMPLEMENTATION_STATES } from '@appling/model/implementation';
import { IMPLEMENTATION_LABELS } from '@appling/viz/views';
import type { GenerationRun, Snapshot } from '../shared/snapshot.js';
import { claimOf } from '../shared/panels.js';

interface ImplementationProps {
    snapshot: Snapshot;
    run?: GenerationRun;
    sessions: AgentSession[];
    /** The element selected on the canvas or in the source. */
    selected?: string;
    onSelect(qn: string): void;
    onGenerate(selection: GenerationSelection): void;
}


/**
 * The code side of the model: how much is implemented, generation through the targets of `appling.config.json`
 * (what changed since the last one, a selection, or everything), the running generation, and the registry tasks with
 * the agent session that claimed each.
 */
export function Implementation({ snapshot, run, sessions, selected, onSelect, onGenerate }: ImplementationProps) {
    const [checked, setChecked] = useState<Set<string>>(new Set());
    const states = Object.entries(snapshot.implementation);
    const counts = useMemo(() => Object.fromEntries(IMPLEMENTATION_STATES.map(s => [s, states.filter(([, i]) => i.state === s).length])), [snapshot]);
    const outstanding = states.filter(([, i]) => i.outstanding).map(([qn]) => qn);
    /** Outstanding elements without their outstanding parents: a parent brings its members. */
    const tops = outstanding.filter(qn => !outstanding.some(other => qn.startsWith(`${other}.`)));
    const running = !!run && !run.ended;
    const none = !snapshot.targets.length;
    const link = (qn: string) => <button className="link" onClick={() => onSelect(qn)}>{qn}</button>;
    const toggle = (qn: string) => setChecked(current => {
        const next = new Set(current);
        if (!next.delete(qn)) next.add(qn);
        return next;
    });

    return (
        <div className="implementation">
            <section>
                <h3>Implementation</h3>
                <ul className="impl-counts">
                    {IMPLEMENTATION_STATES.map(s => <li key={s}><span className={`impl-dot impl-${s}`} /> {counts[s]} {IMPLEMENTATION_LABELS[s]}</li>)}
                </ul>
            </section>
            <section>
                <h3>Generate</h3>
                {none
                    ? <p className="muted">No stack yet: generating asks for one and adds it to appling.config.json.</p>
                    : <ul>{snapshot.targets.map(t => (
                        <li key={t.out}>{t.extension} → {t.out} <span className="muted">{t.generated ? (t.at ? `generated ${new Date(t.at).toLocaleString()}` : 'generated') : 'not generated yet'}</span></li>
                    ))}</ul>}
                {!snapshot.targets.some(t => t.generated) ? (
                    <div className="generate-actions">
                        <button className="button" disabled={running} onClick={() => onGenerate({ mode: 'all' })}>Generate the application</button>
                        <p className="muted">The first generation creates the application from the whole model; then elements generate one by one.</p>
                    </div>
                ) : <div className="generate-actions">
                    <button className="button" disabled={running || !outstanding.length} onClick={() => onGenerate({ mode: 'outstanding' })}>Generate {outstanding.length} outstanding</button>
                    <button className="button" disabled={running || !selected} onClick={() => selected && onGenerate({ mode: 'elements', elements: [selected] })}>Generate {selected ?? 'the selection'}</button>
                    <button className="button" disabled={running || !checked.size} onClick={() => onGenerate({ mode: 'elements', elements: [...checked] })}>Generate {checked.size} checked</button>
                    <button className="button" disabled={running} onClick={() => onGenerate({ mode: 'all' })}>Generate everything</button>
                </div>}
                {tops.length > 0 && (
                    <details>
                        <summary>{tops.length} element{tops.length === 1 ? '' : 's'} new or changed since the last generation</summary>
                        <ul className="outstanding">{tops.slice(0, 300).map(qn => (
                            <li key={qn}>
                                <label><input type="checkbox" checked={checked.has(qn)} onChange={() => toggle(qn)} /> </label>
                                {link(qn)} <span className="muted">{IMPLEMENTATION_LABELS[snapshot.implementation[qn].state]}</span>
                            </li>
                        ))}</ul>
                    </details>
                )}
            </section>
            {run && <RunView run={run} onSelect={onSelect} />}
            <section>
                <h3>Registry tasks</h3>
                {snapshot.tasks.length === 0 && <p className="muted">No open tasks.</p>}
                <ul className="tasks">{snapshot.tasks.map(task => {
                    const claim = claimOf(sessions, task.qn);
                    return (
                        <li key={`${task.target} ${task.qn}`}>
                            <div>
                                {link(task.qn)} <span className={`task-status status-${task.status}`}>{task.status}</span>
                                <span className="muted"> · {task.attempts} attempt{task.attempts === 1 ? '' : 's'} · {task.target}</span>
                                {claim && <span className="claim" style={{ borderColor: claim.color }}> {claim.label ?? claim.name}</span>}
                            </div>
                            <ul className="missing">{task.missing.map(m => <li key={m}>{m}</li>)}</ul>
                            {task.notes.length > 0 && <ul className="notes">{task.notes.map((n, i) => <li key={i} className="muted">{n}</li>)}</ul>}
                        </li>
                    );
                })}</ul>
                <p className="muted">Agent sessions pick these with the MCP tool registry_next, which claims the task for the session.</p>
            </section>
        </div>
    );
}

/** A generation run: its state, what it planned, generated and left as tasks, and its log. */
function RunView({ run, onSelect }: { run: GenerationRun, onSelect(qn: string): void }) {
    const of = <T extends GenerationEvent['type']>(type: T) => run.events.filter((e): e is Extract<GenerationEvent, { type: T }> => e.type === type);
    const done = of('done')[0];
    const failed = of('failed');
    const generated = of('generated').flatMap(e => e.elements);
    const tasks = of('tasks').flatMap(e => e.tasks);
    const steps = of('planned').reduce((sum, e) => sum + e.steps.length, 0);
    return (
        <section className="run">
            <h3>{run.title}</h3>
            <p className={done?.failed || failed.length ? 'errors' : 'muted'}>
                {!run.ended ? 'running…' : done?.failed || failed.length ? 'failed' : 'done'}
                {` · ${steps} planned step${steps === 1 ? '' : 's'} · ${generated.length} generated · ${tasks.length} with open tasks`}
            </p>
            {failed.map((f, i) => <pre key={i} className="errors">{f.target ? `${f.target}: ` : ''}{f.message}</pre>)}
            {of('skipped').map(s => <p key={s.target} className="muted">{s.target}: {s.reason}</p>)}
            {tasks.length > 0 && <ul>{tasks.map(t => <li key={t.qn}><button className="link" onClick={() => onSelect(t.qn)}>{t.qn}</button> <span className="muted">{t.missing.join('; ')}</span></li>)}</ul>}
            <details>
                <summary>Log</summary>
                <pre className="log">{of('log').map(l => `${l.target}: ${l.line}`).join('\n')}</pre>
            </details>
        </section>
    );
}

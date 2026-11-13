import type { AgentSession } from '@appling/ai';
import type { TargetTask } from '@appling/codegen';
import { kindLabel } from '@appling/viz/views';
import { claimOf } from '../shared/panels.js';

/** The groups of the board, in the order a person works through them. */
const GROUPS = [
    { key: 'progress', title: 'In progress', note: 'claimed by an agent session' },
    { key: 'pending', title: 'Pending', note: 'waiting for an agent session' },
    { key: 'done', title: 'Done', note: '' }
] as const;

type Group = typeof GROUPS[number]['key'];

/** Where a task stands: done, claimed by a session, or waiting. */
export function taskGroup(task: TargetTask, sessions: AgentSession[]): Group {
    if (task.status === 'done') return 'done';
    return claimOf(sessions, task.qn) ? 'progress' : 'pending';
}

/**
 * Every registry task over the canvas, grouped in progress, pending and done, each group in plan order. A click on a
 * task selects its element, so the canvas unfolds to it.
 */
export function TaskBoard({ tasks, sessions, selected, onSelect, onClose }: { tasks: TargetTask[], sessions: AgentSession[], selected?: string, onSelect(qn: string): void, onClose(): void }) {
    const targets = new Set(tasks.map(t => t.target)).size;
    return (
        <aside className="task-board" aria-label="Tasks" onKeyDown={event => { if (event.key === 'Escape') onClose(); }}>
            <header>
                <h3>Tasks</h3>
                <span className="muted">{tasks.filter(t => t.status === 'done').length} of {tasks.length} done</span>
                <button className="link" onClick={onClose} aria-label="Close the tasks">×</button>
            </header>
            {!tasks.length && <p className="muted">No registry tasks. Generating the model leaves a task for every part the generator could not write; agent sessions take them with registry_next.</p>}
            {GROUPS.map(group => {
                const shown = tasks.filter(t => taskGroup(t, sessions) === group.key);
                if (!shown.length) return null;
                return (
                    <section key={group.key} className={`task-group ${group.key}`}>
                        <h4>{group.title} <span>{shown.length}</span>{group.note && <span className="muted"> · {group.note}</span>}</h4>
                        <ol>{shown.map(task => {
                            const claim = claimOf(sessions, task.qn);
                            return (
                                <li key={`${task.target} ${task.qn}`} className={task.qn === selected ? 'selected' : ''}>
                                    <button onClick={() => onSelect(task.qn)} title={[...task.missing, ...task.notes].join('\n')}>
                                        <span className="task-line">
                                            <strong>{task.qn}</strong>
                                            <span className="muted">{kindLabel(task.kind)}</span>
                                            {task.status === 'partial' && <span className="task-status">partly written</span>}
                                            {claim && <span className="claim" style={{ borderColor: claim.color }}>{claim.label ?? claim.name}</span>}
                                        </span>
                                        {task.status !== 'done' && task.missing[0] && <span className="task-missing">{task.missing[0]}{task.missing.length > 1 ? ` and ${task.missing.length - 1} more` : ''}</span>}
                                        {(task.attempts > 0 || targets > 1) && <span className="muted task-meta">{[task.attempts > 0 && `${task.attempts} attempt${task.attempts === 1 ? '' : 's'}`, targets > 1 && task.target].filter(Boolean).join(' · ')}</span>}
                                    </button>
                                </li>
                            );
                        })}</ol>
                    </section>
                );
            })}
        </aside>
    );
}

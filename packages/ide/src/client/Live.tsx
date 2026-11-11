import { useEffect, useState } from 'react';
import type { AgentSession } from '@appling/ai';
import type { ElementChange } from '@appling/model/diff';
import { kindLabel } from '@appling/viz/views';
import type { Decision, LiveChanges, LiveFile, Proposal } from '../shared/live.js';
import { TextDiff } from './Review.js';

interface LiveProps {
    live?: LiveChanges;
    proposals: Proposal[];
    sessions: AgentSession[];
    onAccept(paths?: string[]): void;
    onRevert(path: string): void;
    onDecide(id: string, decision: Decision): void;
    onSelect(qn: string): void;
    /** A file whose text diff opens, such as when the Inspector asks for a live changed element's diff. */
    openPath?: { path: string };
}

const STATUS: Record<LiveFile['status'], string> = { added: 'A', modified: 'M', deleted: 'D' };

/**
 * Beside the canvas: the proposals agent sessions wait on, then every model change since the user last accepted, per
 * file, with the session that wrote it, its model diff and its text diff, to accept (stop marking it) or revert.
 */
export function Live({ live, proposals, sessions, onAccept, onRevert, onDecide, onSelect, openPath }: LiveProps) {
    const [open, setOpen] = useState<string>();
    useEffect(() => { if (openPath) setOpen(openPath.path); }, [openPath]);
    const byId = new Map(sessions.map(s => [s.id, s]));
    const changes = new Map((live?.diff.changes ?? []).map(c => [c.qn, c]));
    const files = live?.files ?? [];

    return (
        <div className="review live">
            {proposals.length > 0 && <h3>Proposed changes</h3>}
            {proposals.map(p => <ProposalCard key={p.id} proposal={p} session={byId.get(p.session)} onDecide={decision => onDecide(p.id, decision)} onSelect={onSelect} />)}

            <h3>Changes</h3>
            {!files.length && <p className="muted">No unseen changes. Every change to the model, by an agent session or anything else that writes the files, is marked here and on the canvas until you accept it.</p>}
            {files.length > 0 && (
                <p className="review-summary">
                    <span className="added">{live!.diff.added.length} added</span> · <span className="changed">{live!.diff.changed.length} changed</span> · <span className="removed">{live!.diff.removed.length} removed</span>
                    {' '}<button className="link" onClick={() => onAccept()}>accept all</button>
                </p>
            )}
            <ul className="review-list">
                {files.map(file => (
                    <li key={file.path} className="live-file">
                        <div className={`review-item ${file.status === 'modified' ? 'changed' : file.status === 'added' ? 'added' : 'removed'}`}>
                            <button className="result" onClick={() => setOpen(open === file.path ? undefined : file.path)} title={`${file.path}\n${new Date(file.at).toLocaleString()}`}>
                                <span>{file.path}</span>
                                <span className="muted">{STATUS[file.status]}</span>
                            </button>
                        </div>
                        <p className="review-detail muted">
                            {file.sessions.length
                                ? file.sessions.map(id => <SessionTag key={id} session={byId.get(id)} />)
                                : <span title="Written to disk outside an agent session's MCP tools">written to disk</span>}
                            {' · '}{new Date(file.at).toLocaleTimeString()}
                        </p>
                        {file.elements.length > 0 && (
                            <ul className="review-list live-elements">
                                {file.elements.map(qn => changes.get(qn)).filter((c): c is ElementChange => !!c).map(change => (
                                    <li key={`${change.status} ${change.qn}`} className={`review-item ${change.status}`}>
                                        <button className="result" onClick={() => onSelect(change.qn)} title={change.qn}>
                                            <span>{change.qn}</span>
                                            <span className="muted">{change.status} {kindLabel(change.kind)}{change.status === 'changed' && change.props.length ? ` · ${change.props.join(', ')}` : ''}</span>
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                        <div className="proposal-actions">
                            <button className="button" onClick={() => onAccept([file.path])}>Accept</button>
                            <button className="button" title={file.before === null ? 'Delete the file' : 'Write the text you last accepted back'} onClick={() => onRevert(file.path)}>Revert</button>
                            <button className="link" onClick={() => setOpen(open === file.path ? undefined : file.path)}>{open === file.path ? 'hide text diff' : 'text diff'}</button>
                        </div>
                        {open === file.path && <TextDiff before={file.before ?? ''} after={file.after ?? ''} />}
                    </li>
                ))}
            </ul>
        </div>
    );
}

function SessionTag({ session }: { session?: AgentSession }) {
    if (!session) return <span className="session-tag">ended session</span>;
    return <span className="session-tag" title={session.id}><span className="session-dot" style={{ background: session.color }} />{session.label ?? session.name}</span>;
}

function ProposalCard({ proposal, session, onDecide, onSelect }: { proposal: Proposal, session?: AgentSession, onDecide(decision: Decision): void, onSelect(qn: string): void }) {
    const [comment, setComment] = useState('');
    const { review } = proposal;
    return (
        <div className="proposal">
            <span><SessionTag session={session} /> proposes</span>
            <p>{review.summary}</p>
            {review.hunks.map((hunk, i) => (
                <pre key={i} className="hunk">
                    <div className="hunk-file">{hunk.file}:{hunk.line}</div>
                    {hunk.removed.map((line, j) => <div key={`r${j}`} className="removed">- {line}</div>)}
                    {hunk.added.map((line, j) => <div key={`a${j}`} className="added">+ {line}</div>)}
                </pre>
            ))}
            <p className="graph-changes">
                {review.graph.added.map(qn => <button key={qn} className="link added" onClick={() => onSelect(qn)}>+ {qn}</button>)}
                {review.graph.removed.map(qn => <span key={qn} className="removed">- {qn}</span>)}
                {review.graph.changed.map(qn => <button key={qn} className="link" onClick={() => onSelect(qn)}>~ {qn}</button>)}
            </p>
            <input className="proposal-comment" placeholder="Comment for the agent (optional)" value={comment} onChange={e => setComment(e.target.value)} />
            <div className="proposal-actions">
                <button className="button" onClick={() => onDecide({ accepted: true })}>Accept</button>
                <button className="button" onClick={() => onDecide({ accepted: false, comment: comment.trim() || undefined })}>Reject</button>
            </div>
        </div>
    );
}

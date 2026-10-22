import { useState } from 'react';
import type { Proposal } from '@appling/ai';
import type { EditOperation } from '@appling/model';
import { chatTurn } from './api.js';

interface Turn {
    role: 'user' | 'assistant';
    content: string;
    tools?: string[];
    proposal?: Proposal;
    state?: 'open' | 'accepted' | 'rejected';
    errors?: string[];
}

interface ChatProps {
    onEdit(operation: EditOperation): Promise<string[]>;
    onSelect(qn: string): void;
}

/** Chat about the model. The assistant's edits arrive as a proposal with text and graph differences to accept or reject. */
export function Chat({ onEdit, onSelect }: ChatProps) {
    const [turns, setTurns] = useState<Turn[]>([]);
    const [draft, setDraft] = useState('');
    const [busy, setBusy] = useState(false);

    const update = (index: number, change: (turn: Turn) => Turn) => setTurns(current => current.map((t, i) => (i === index ? change(t) : t)));

    const send = async () => {
        const question = draft.trim();
        if (!question || busy) return;
        const history = [...turns.map(t => ({ role: t.role, content: t.content })), { role: 'user' as const, content: question }];
        const index = turns.length + 1;
        setTurns([...turns, { role: 'user', content: question }, { role: 'assistant', content: '', tools: [] }]);
        setDraft('');
        setBusy(true);
        for await (const event of chatTurn(history)) {
            if (event.type === 'text') update(index, t => ({ ...t, content: t.content + event.text }));
            if (event.type === 'tool') update(index, t => ({ ...t, tools: [...(t.tools ?? []), event.name] }));
            if (event.type === 'proposal') update(index, t => ({ ...t, proposal: event.proposal, state: 'open' }));
            if (event.type === 'error') update(index, t => ({ ...t, errors: [...(t.errors ?? []), event.message] }));
        }
        setBusy(false);
    };

    const accept = async (index: number, proposal: Proposal) => {
        for (const operation of proposal.operations) {
            const errors = await onEdit(operation);
            if (errors.length) return update(index, t => ({ ...t, errors: [...(t.errors ?? []), ...errors] }));
        }
        update(index, t => ({ ...t, state: 'accepted' }));
    };

    return (
        <div className="chat">
            <div className="chat-turns">
                {turns.length === 0 && <p className="muted">Ask about the model or ask for a change. Changes come back as a proposal you can review.</p>}
                {turns.map((turn, index) => (
                    <div key={index} className={`turn turn-${turn.role}`}>
                        {turn.tools && turn.tools.length > 0 && <div className="turn-tools">{turn.tools.join(' · ')}</div>}
                        {turn.content && <p>{turn.content}</p>}
                        {turn.errors?.map(e => <p key={e} className="turn-error">{e}</p>)}
                        {turn.proposal && (
                            <div className="proposal">
                                <div className="eyebrow">Proposal · {turn.proposal.operations.length} edit(s)</div>
                                {turn.proposal.hunks.map(h => (
                                    <pre key={`${h.file}${h.line}`} className="hunk">
                                        <span className="hunk-file">{h.file}:{h.line}</span>{'\n'}
                                        {h.removed.map((l, i) => <span key={`r${i}`} className="removed">- {l}{'\n'}</span>)}
                                        {h.added.map((l, i) => <span key={`a${i}`} className="added">+ {l}{'\n'}</span>)}
                                    </pre>
                                ))}
                                <GraphChanges label="added" items={turn.proposal.graph.added} onSelect={onSelect} />
                                <GraphChanges label="changed" items={turn.proposal.graph.changed} onSelect={onSelect} />
                                <GraphChanges label="removed" items={turn.proposal.graph.removed} />
                                {turn.state === 'open'
                                    ? <div className="proposal-actions">
                                        <button className="button" onClick={() => accept(index, turn.proposal!)}>Accept</button>
                                        <button className="button" onClick={() => update(index, t => ({ ...t, state: 'rejected' }))}>Reject</button>
                                    </div>
                                    : <p className="muted">{turn.state}</p>}
                            </div>
                        )}
                    </div>
                ))}
            </div>
            <form className="chat-input" onSubmit={event => { event.preventDefault(); send(); }}>
                <textarea value={draft} rows={3} placeholder="Add an invoice entity with a due date" onChange={e => setDraft(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
                <button className="button" type="submit" disabled={busy || !draft.trim()}>{busy ? 'Working…' : 'Send'}</button>
            </form>
        </div>
    );
}

function GraphChanges({ label, items, onSelect }: { label: string, items: string[], onSelect?(qn: string): void }) {
    if (!items.length) return null;
    return (
        <p className="graph-changes">
            <span className="muted">{label}</span>{' '}
            {items.map(qn => onSelect ? <button key={qn} className="link" onClick={() => onSelect(qn)}>{qn}</button> : <span key={qn}>{qn}</span>)}
        </p>
    );
}

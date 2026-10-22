import { useEffect, useState } from 'react';
import type { EditOperation } from '@appling/model';
import type { GraphIndex } from './graph/model.js';

interface InspectorProps {
    index: GraphIndex;
    qn?: string;
    onSelect(qn: string): void;
    /** Applies an edit operation; resolves to the reasons it was rejected, or an empty list. */
    onEdit(operation: EditOperation): Promise<string[]>;
}

const TYPED = new Set(['Field', 'Param']);

export function Inspector({ index, qn, onSelect, onEdit }: InspectorProps) {
    const node = qn ? index.nodes.get(qn) : undefined;
    const [errors, setErrors] = useState<string[]>([]);
    const [removing, setRemoving] = useState(false);
    useEffect(() => {
        setErrors([]);
        setRemoving(false);
    }, [qn]);
    if (!node) return <aside className="inspector"><p className="muted">Select an element in the text or the graph.</p></aside>;

    const edit = async (operation: EditOperation) => setErrors(await onEdit(operation));
    const parent = index.parent(node.qn);
    const name = node.qn.slice((parent?.length ?? -1) + 1);
    const named = /^[_a-zA-Z]\w*$/.test(name);
    const outgoing = index.graph.edges.filter(e => e.from === node.qn && e.kind !== 'contains');
    const incoming = index.graph.edges.filter(e => e.to === node.qn && e.kind !== 'contains');
    const link = (target: string) => <button className="link" onClick={() => onSelect(target)}>{target}</button>;
    const editable = Object.entries(node.props).filter(([key]) => !(TYPED.has(node.kind) && key === 'type'));

    return (
        <aside className="inspector">
            <div className="eyebrow">{node.kind} · {node.layer}</div>
            <h2>{node.qn}</h2>
            {errors.length > 0 && <ul className="errors" role="alert">{errors.map(e => <li key={e}>{e}</li>)}</ul>}
            {named && node.kind !== 'Module' && (
                <TextField label="Name" value={name} action="Rename" onSubmit={value => edit({ op: 'rename', target: node.qn, name: value })} />
            )}
            {TYPED.has(node.kind) && (
                <TextField label="Type" value={String(node.props.type ?? '')} action="Retype" onSubmit={value => edit({ op: 'retype', target: node.qn, type: value })} />
            )}
            {editable.map(([key, value]) => (
                <TextField key={key} label={key} value={Array.isArray(value) ? value.join(key === 'modifiers' ? ' ' : '\n') : String(value)} action="Set" multiline={Array.isArray(value) && key !== 'modifiers'}
                    onSubmit={text => edit({ op: 'set', target: node.qn, property: key, value: text })} />
            ))}
            <TextField label="Add a member" value="" placeholder={node.kind === 'Module' ? 'entity Customer { name: String }' : 'note: Text?'} action="Add" multiline
                onSubmit={source => edit({ op: 'add', parent: node.qn, source })} />
            {node.kind !== 'Module' || parent ? (
                <div className="danger">
                    {removing
                        ? <><button className="button danger-button" onClick={() => edit({ op: 'remove', target: node.qn })}>Remove {name}</button> <button className="button" onClick={() => setRemoving(false)}>Keep</button></>
                        : <button className="button" onClick={() => setRemoving(true)}>Remove…</button>}
                </div>
            ) : null}
            <Section title="Contains" items={index.children(node.qn).map(c => <li key={c.qn}>{link(c.qn)}</li>)} />
            <Section title="Refers to" items={outgoing.map(e => <li key={`${e.kind}${e.to}`}><span className="muted">{e.kind}</span> {link(e.to)}</li>)} />
            <Section title="Referred by" items={incoming.map(e => <li key={`${e.kind}${e.from}`}><span className="muted">{e.kind}</span> {link(e.from)}</li>)} />
        </aside>
    );
}

function TextField({ label, value, action, multiline, placeholder, onSubmit }: { label: string, value: string, action: string, multiline?: boolean, placeholder?: string, onSubmit(value: string): void }) {
    const [text, setText] = useState(value);
    useEffect(() => setText(value), [value]);
    const changed = text !== value && (action !== 'Add' || text.trim() !== '');
    return (
        <form className="field" onSubmit={event => { event.preventDefault(); if (changed) onSubmit(text); }}>
            <label>
                <span>{label}</span>
                {multiline
                    ? <textarea value={text} placeholder={placeholder} rows={Math.min(6, Math.max(2, text.split('\n').length))} onChange={e => setText(e.target.value)} />
                    : <input value={text} placeholder={placeholder} onChange={e => setText(e.target.value)} />}
            </label>
            <button className="button" type="submit" disabled={!changed}>{action}</button>
        </form>
    );
}

function Section({ title, items }: { title: string, items: React.ReactNode[] }) {
    return items.length ? <section><h3>{title}</h3><ul>{items}</ul></section> : null;
}

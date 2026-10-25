import { useEffect, useMemo, useState } from 'react';
import { Simulator, type Access, type Verdict } from '@appling/model/simulator';
import type { EditOperation } from '@appling/model';
import { abilities, actionSummary, entityActions, kindLabel, LAYER_LABELS, memberText, policyText, relations, type Ability, type GraphIndex } from '@appling/viz/views';

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
    if (!node) return <div className="inspector"><p className="muted">Select an element in the text or the graph.</p></div>;

    const edit = async (operation: EditOperation) => setErrors(await onEdit(operation));
    const parent = index.parent(node.qn);
    const name = node.qn.slice((parent?.length ?? -1) + 1);
    const named = /^[_a-zA-Z]\w*$/.test(name);
    const link = (target: string, text = target) => <button className="link" onClick={() => onSelect(target)}>{text}</button>;
    const editable = Object.entries(node.props).filter(([key, value]) => typeof value !== 'boolean' && !(TYPED.has(node.kind) && key === 'type'));

    return (
        <div className="inspector">
            <div className="eyebrow">{node.props.link ? 'link ' : ''}{kindLabel(node.kind)} · {LAYER_LABELS[node.layer]}</div>
            <h2>{node.qn}</h2>
            {errors.length > 0 && <ul className="errors" role="alert">{errors.map(e => <li key={e}>{e}</li>)}</ul>}
            {node.kind === 'Action' && <WhatItDoes index={index} qn={node.qn} link={link} />}
            {node.kind === 'Actor' && <WhatTheyCanDo index={index} qn={node.qn} link={link} />}
            {node.kind === 'Entity' && <Section title="Actions" items={entityActions(index, node.qn).map(a => (
                <li key={a.qn}>{link(a.qn)} <span className="muted">{[a.creates ? 'creates' : '', ...a.transitions].filter(Boolean).join(', ')}</span></li>
            ))} />}
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
            <Behavior index={index} qn={node.qn} kind={node.kind} link={link} />
            <Section title="Members" items={index.children(node.qn).map(c => <li key={c.qn}>{link(c.qn, memberText(c, index))} <span className="muted">{kindLabel(c.kind)}</span></li>)} />
            <Relations title="Used by" index={index} qn={node.qn} direction="usedBy" link={link} />
            <Relations title="Uses" index={index} qn={node.qn} direction="uses" link={link} />
        </div>
    );
}

/** What the simulator says about an action or a machine. */
function Behavior({ index, qn, kind, link }: { index: GraphIndex, qn: string, kind: string, link(qn: string): React.ReactNode }) {
    const simulator = useMemo(() => new Simulator(index.graph), [index]);
    if (kind === 'Action') {
        const verdicts = { yes: 'may', no: 'may not', depends: 'depends on the data' };
        return (
            <>
                <Section title="Who may trigger it" items={simulator.actors(qn).map(a => <li key={a.actor}>{link(a.actor)} <span className="muted">{verdicts[a.verdict]}</span></li>)} />
                <Section title="Invariants at risk" items={simulator.risks(qn).map(r => <li key={r.invariant}>{link(r.invariant)} <span className="muted">reads {r.fields.join(', ')}</span></li>)} />
            </>
        );
    }
    if (kind === 'Machine') {
        const field = index.nodes.get(String(index.nodes.get(qn)!.data.field));
        const states = field ? index.children(String((field.data.type as { decl?: string }).decl)).map(l => l.qn.slice(l.qn.lastIndexOf('.') + 1)) : [];
        return (
            <Section title="Reachable states" items={states.map(state => {
                const reach = simulator.reach(qn, state);
                return <li key={state}>{state} <span className="muted">{reach ? (reach.path.length ? `via ${reach.path.map(p => p.trigger).join(', ')}` : 'initial') : 'unreachable'}</span></li>;
            })} />
        );
    }
    return null;
}

const VERDICTS: Record<Verdict, string> = { yes: 'may', no: 'may not', depends: 'depends on the data' };
const ORDER: Verdict[] = ['yes', 'depends', 'no'];

/** What an actor may do and under which policies, by the simulator: allowed and data dependent first, refused folded away. */
function WhatTheyCanDo({ index, qn, link }: { index: GraphIndex, qn: string, link(qn: string, text?: string): React.ReactNode }) {
    const groups = useMemo(() => abilities(index, new Simulator(index.graph).access(qn)), [index, qn]);
    const verdict = (entry: Access) => <span className={`verdict verdict-${entry.verdict}`}>{VERDICTS[entry.verdict]}</span>;
    const item = (entry: Ability) => (
        <li key={`${entry.target} ${entry.operation ?? ''} ${entry.fields ?? ''}`}>
            {link(entry.target)}{entry.operation && ` ${entry.operation}`}{entry.fields && ` fields ${entry.fields.join(', ')}`} {verdict(entry)}
            <ul className="policies">
                {entry.policies.length ? entry.policies.map(p => <li key={p}>{link(p, policyText(index, p))}</li>) : <li className="muted">no policy</li>}
            </ul>
            {entry.offers && entry.offers.length > 0 && (
                <ul className="offers">{entry.offers.map(o => <li key={o.target}>offers {link(o.target)} {verdict(o)}</li>)}</ul>
            )}
        </li>
    );
    return (
        <section>
            <h3>What they can do</h3>
            {[...groups].map(([label, entries]) => {
                const sorted = [...entries].sort((a, b) => ORDER.indexOf(a.verdict) - ORDER.indexOf(b.verdict));
                const refused = sorted.filter(e => e.verdict === 'no');
                return (
                    <div key={label} className="abilities">
                        <h4>{label}</h4>
                        <ul>{sorted.filter(e => e.verdict !== 'no').map(item)}</ul>
                        {refused.length > 0 && <details><summary>may not ({refused.length})</summary><ul>{refused.map(item)}</ul></details>}
                    </div>
                );
            })}
        </section>
    );
}

/** An action in the words of the model: what it works on, takes, requires and changes. */
function WhatItDoes({ index, qn, link }: { index: GraphIndex, qn: string, link(qn: string): React.ReactNode }) {
    const summary = actionSummary(index, qn);
    const rows: [string, React.ReactNode][] = [
        ['On', summary.on && link(summary.on)],
        ['Input', summary.inputs.join('\n')],
        ['Requires', summary.requires.join('\n')],
        ['Changes', summary.changes.join('\n') || 'nothing in the model'],
        ['Errors', summary.errors.join(', ')],
        ['Consistency', summary.consistency]
    ];
    return (
        <section>
            <h3>What it does</h3>
            <dl>{rows.filter(([, value]) => value).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        </section>
    );
}

/** The declarations around an element, by layer, so its behavior, use and exposure read at a glance. */
function Relations({ title, index, qn, direction, link }: { title: string, index: GraphIndex, qn: string, direction: 'uses' | 'usedBy', link(qn: string): React.ReactNode }) {
    const byLayer = relations(index, qn, direction);
    if (!byLayer.size) return null;
    return (
        <section>
            <h3>{title}</h3>
            {[...byLayer].map(([layer, items]) => (
                <div key={layer} className={`relations layer-${layer}`}>
                    <h4>{LAYER_LABELS[layer]}</h4>
                    <ul>{items.map(r => (
                        <li key={r.qn}>{link(r.qn)} <span className="muted">{kindLabel(r.kind)}{r.via.length ? ` via ${r.via.join(', ')}` : ''}</span></li>
                    ))}</ul>
                </div>
            ))}
        </section>
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

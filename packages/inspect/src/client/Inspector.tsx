import { useMemo } from 'react';
import { Simulator, type Access, type Verdict } from '@appling/model/simulator';
import type { ElementChange } from '@appling/model/diff';
import { abilities, actionSummary, entityActions, kindLabel, LAYER_LABELS, memberText, policyText, relations, type Ability, type GraphIndex } from '@appling/viz/views';

interface InspectorProps {
    index: GraphIndex;
    qn: string;
    onSelect(qn: string): void;
    onClose(): void;
    /** Opens the element's source in the host's editor, where the host offers it. */
    onOpenSource?(qn: string): void;
    /** How the element changed, while the canvas marks the review's or the live changes. */
    change?: ElementChange;
    /** The address of a selected sub-anchor of the element (a declaring line that is no element). */
    anchor?: string;
}

/** The selected element over the canvas: what it is, what it does and its relations, read only. */
export function Inspector({ index, qn, onSelect, onClose, onOpenSource, change, anchor }: InspectorProps) {
    const node = index.nodes.get(qn);
    if (!node) return null;

    const link = (target: string, text = target) => <button className="link" onClick={() => onSelect(target)}>{text}</button>;

    return (
        <aside className={`inspector layer-${node.layer}`} aria-label="Inspector">
            <header className="inspector-head" key={node.qn}>
                <div className="inspector-kind"><i />{node.props.link ? 'link ' : ''}{kindLabel(node.kind)}<span className="muted">{LAYER_LABELS[node.layer]}</span></div>
                <button className="inspector-close" aria-label="Close" onClick={onClose}>×</button>
                <h2>{node.qn}</h2>
                {onOpenSource && <button className="button" onClick={() => onOpenSource(node.qn)}>Open source</button>}
            </header>
            <div className="inspector-body" key={`body ${node.qn}`}>
            {anchor && <p><span className="muted">line</span> <code>{anchor.slice(node.qn.length)}</code></p>}
            {change && (
                <p className={`review-item ${change.status}`}>
                    {change.status}{change.was && ` from ${change.was}`}{change.status === 'changed' && change.props.length > 0 && ` · ${change.props.join(', ')}`}
                </p>
            )}
            {node.kind === 'Action' && <WhatItDoes index={index} qn={node.qn} link={link} />}
            {node.kind === 'Actor' && <WhatTheyCanDo index={index} qn={node.qn} link={link} />}
            {node.kind === 'Entity' && <Section title="Actions" items={entityActions(index, node.qn).map(a => (
                <li key={a.qn}>{link(a.qn)} <span className="muted">{[a.creates ? 'creates' : '', ...a.transitions].filter(Boolean).join(', ')}</span></li>
            ))} />}
            <Behavior index={index} qn={node.qn} kind={node.kind} link={link} />
            <Section title="Members" items={index.children(node.qn).map(c => <li key={c.qn}>{link(c.qn, memberText(c, index))} <span className="muted">{kindLabel(c.kind)}</span></li>)} />
            <Relations title="Used by" index={index} qn={node.qn} direction="usedBy" link={link} />
            <Relations title="Uses" index={index} qn={node.qn} direction="uses" link={link} />
            </div>
        </aside>
    );
}

/** What the simulator says about an action or a machine. */
function Behavior({ index, qn, kind, link }: { index: GraphIndex, qn: string, kind: string, link(qn: string): React.ReactNode }) {
    const simulator = useMemo(() => new Simulator(index.graph), [index]);
    if (kind === 'Action') {
        return (
            <>
                <Section title="Who may trigger it" items={simulator.actors(qn).filter(a => a.verdict !== 'no').map(a => <li key={a.actor}>{link(a.actor)} <span className="muted">{VERDICTS[a.verdict]}</span></li>)} />
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

/** What an actor may do and under which policies, by the simulator: allowed first, then data dependent; refused is left out. */
function WhatTheyCanDo({ index, qn, link }: { index: GraphIndex, qn: string, link(qn: string, text?: string): React.ReactNode }) {
    const groups = useMemo(() => abilities(index, new Simulator(index.graph).access(qn)), [index, qn]);
    const verdict = (entry: Access) => <span className={`verdict verdict-${entry.verdict}`}>{VERDICTS[entry.verdict]}</span>;
    const item = (entry: Ability) => (
        <li key={`${entry.target} ${entry.operation ?? ''} ${entry.fields ?? ''}`}>
            {link(entry.target)}{entry.operation && ` ${entry.operation}`}{entry.fields && ` fields ${entry.fields.join(', ')}`} {verdict(entry)}
            <ul className="policies">
                {entry.policies.length ? entry.policies.map(p => <li key={p}>{link(p, policyText(index, p))}</li>) : <li className="muted">no policy</li>}
            </ul>
            {entry.offers?.some(o => o.verdict !== 'no') && (
                <ul className="offers">{entry.offers.filter(o => o.verdict !== 'no').map(o => <li key={o.target}>offers {link(o.target)} {verdict(o)}</li>)}</ul>
            )}
        </li>
    );
    return (
        <section>
            <h3>What they can do</h3>
            {[...groups].map(([label, entries]) => {
                const allowed = entries.filter(e => e.verdict !== 'no').sort((a, b) => Number(a.verdict === 'depends') - Number(b.verdict === 'depends'));
                return allowed.length > 0 && (
                    <div key={label} className="abilities">
                        <h4>{label}</h4>
                        <ul>{allowed.map(item)}</ul>
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

function Section({ title, items }: { title: string, items: React.ReactNode[] }) {
    return items.length ? <section><h3>{title} <span className="count">{items.length}</span></h3><ul>{items}</ul></section> : null;
}

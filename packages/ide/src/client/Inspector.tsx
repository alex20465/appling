import type { GraphIndex } from './graph/model.js';

interface InspectorProps {
    index: GraphIndex;
    qn?: string;
    onSelect(qn: string): void;
}

export function Inspector({ index, qn, onSelect }: InspectorProps) {
    const node = qn ? index.nodes.get(qn) : undefined;
    if (!node) return <aside className="inspector"><p className="muted">Select an element in the text or the graph.</p></aside>;
    const outgoing = index.graph.edges.filter(e => e.from === node.qn && e.kind !== 'contains');
    const incoming = index.graph.edges.filter(e => e.to === node.qn && e.kind !== 'contains');
    const link = (target: string) => <button className="link" onClick={() => onSelect(target)}>{target}</button>;
    return (
        <aside className="inspector">
            <div className="eyebrow">{node.kind} · {node.layer}</div>
            <h2>{node.qn}</h2>
            {Object.keys(node.props).length > 0 && (
                <dl>
                    {Object.entries(node.props).map(([key, value]) => (
                        <div key={key}><dt>{key}</dt><dd>{Array.isArray(value) ? value.join('\n') : String(value)}</dd></div>
                    ))}
                </dl>
            )}
            <Section title="Contains" items={index.children(node.qn).map(c => <li key={c.qn}>{link(c.qn)}</li>)} />
            <Section title="Refers to" items={outgoing.map(e => <li key={`${e.kind}${e.to}`}><span className="muted">{e.kind}</span> {link(e.to)}</li>)} />
            <Section title="Referred by" items={incoming.map(e => <li key={`${e.kind}${e.from}`}><span className="muted">{e.kind}</span> {link(e.from)}</li>)} />
        </aside>
    );
}

function Section({ title, items }: { title: string, items: React.ReactNode[] }) {
    return items.length ? <section><h3>{title}</h3><ul>{items}</ul></section> : null;
}

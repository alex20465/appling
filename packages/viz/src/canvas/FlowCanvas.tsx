import { useMemo, useState } from 'react';
import { layoutFlow } from '../layout.js';
import type { Bubble } from '../protocol.js';
import { anchorOf, type Flow, type GraphIndex } from '../views.js';
import { BubbleView, LooseBubbles, memberOf, type BubbleStep } from './Bubble.js';

interface FlowProps {
    index: GraphIndex;
    flow: Flow;
    selected?: string;
    bubbles?: Bubble[];
    /** The place of the shown bubble among all, for its back and next buttons. */
    step?: BubbleStep;
    /** Draws only the edges that leave the node clicked last, such as where a state can go. */
    edgesOnClick?: boolean;
    onSelect(qn: string): void;
    onOpenFile?(file: string, line: number): void;
}

/** A flowchart of states or steps: click a node or an edge label to select its element. */
export function FlowCanvas({ index, flow, selected, bubbles = [], edgesOnClick, onSelect, onOpenFile, step }: FlowProps) {
    const placed = useMemo(() => layoutFlow(flow), [flow]);
    const [open, setOpen] = useState<string>();
    const edges = useMemo(() => edgesOnClick ? placed.edges.filter(e => e.edge.from === open) : placed.edges, [placed, open, edgesOnClick]);
    const press = (id: string, qn?: string) => {
        setOpen(open === id ? undefined : id);
        if (qn) onSelect(qn);
    };
    /** Where a bubble points: right of a node, or at an edge label. */
    const anchors = useMemo(() => {
        const at = new Map<string, { x: number, y: number }>();
        for (const n of placed.nodes) for (const key of [n.node.id, n.node.qn]) if (key && !at.has(key)) at.set(key, { x: n.x + n.width / 2, y: n.y });
        for (const e of edges) for (const key of [e.edge.of, e.edge.qn]) if (key && !at.has(key)) at.set(key, { x: e.x + 12, y: e.y });
        return at;
    }, [placed, edges]);
    const drawn = new Set(anchors.keys());
    const placedBubbles = bubbles.map(bubble => ({ bubble, anchor: index.nodes.has(bubble.target) ? anchorOf(index, bubble.target, drawn) : undefined }));
    return (
        <div className="flow">
            <div className="flow-board" style={{ width: placed.width, height: placed.height }}>
                <svg width={placed.width} height={placed.height} role="img" aria-label="Flowchart">
                    <defs>
                        <marker id="flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                            <path d="M 0 0 L 10 5 L 0 10 z" />
                        </marker>
                    </defs>
                    {edges.map((e, i) => <path key={i} className="flow-edge" d={e.path} markerEnd="url(#flow-arrow)" />)}
                    {placed.nodes.map(({ node, x, y, width, height }) => (
                        <g key={node.id} className={`flow-node${node.tag ? ` ${node.tag}` : ''}${node.qn && node.qn === selected ? ' selected' : ''}${node.id === open ? ' open' : ''}`} transform={`translate(${x - width / 2} ${y - height / 2})`} onClick={() => press(node.id, node.qn)}>
                            <rect width={width} height={height} rx={8} />
                            {node.tag === 'final' && <rect className="inner" x={3} y={3} width={width - 6} height={height - 6} rx={6} />}
                            <text className="flow-label" x={width / 2} y={node.note ? 19 : 20}>{node.label}</text>
                            {node.note && <text className="flow-note" x={width / 2} y={35}>{node.note}</text>}
                        </g>
                    ))}
                    {edges.filter(e => e.edge.label).map((e, i) => (
                        <g key={i} className={`flow-edge-label${e.edge.qn && e.edge.qn === selected ? ' selected' : ''}`} transform={`translate(${e.x} ${e.y})`} onClick={() => e.edge.qn && onSelect(e.edge.qn)}>
                            <text y={e.edge.note ? -2 : 4}>{e.edge.label}</text>
                            {e.edge.note && <text className="flow-note" y={13}>{e.edge.note}</text>}
                        </g>
                    ))}
                </svg>
                {placedBubbles.filter(b => b.anchor).map(({ bubble, anchor }, i) => {
                    const { x, y } = anchors.get(anchor!)!;
                    return <BubbleView key={`${i} ${bubble.target} ${bubble.text}`} bubble={bubble} member={memberOf(bubble, anchor!)} reveal tail="left" style={{ left: x + 12, top: y }} step={step} onOpenFile={onOpenFile} />;
                })}
            </div>
            {edgesOnClick && !open && <p className="flow-hint">click a state to see where it can go</p>}
            <LooseBubbles bubbles={placedBubbles.filter(b => !b.anchor).map(b => b.bubble)} step={step} onOpenFile={onOpenFile} />
        </div>
    );
}

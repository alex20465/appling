import { useEffect, useMemo, useState } from 'react';
import {
    Background, Controls, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, useNodesState, useReactFlow,
    type Edge, type Node, type NodeProps
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { Layout, Level, Position as Point } from '../../shared/snapshot.js';
import { CARD_WIDTH, layoutView, type Box } from './layout.js';
import { levelForZoom, shownFor, view, type Card, type GraphIndex } from './model.js';
import type { Dependency, EditOperation } from '@appling/model';

interface GraphProps {
    index: GraphIndex;
    dependencies: Dependency[];
    layout: Layout;
    selected?: string;
    onSelect(qn: string): void;
    onMoved(level: Level, qn: string, position: Point): void;
    onEdit(operation: EditOperation): Promise<string[]>;
}

const HOLDERS = new Set(['Entity', 'ValueType', 'Event']);
const TYPES = new Set(['Entity', 'Enum', 'ValueType']);

type CardData = { card: Card, selected: boolean, row?: string, onSelect(qn: string): void };

const ZOOM: Record<Level, number> = { out: 0.4, medium: 0.8, in: 1.25 };
const nodeTypes = { card: CardNode, module: ModuleNode };

export function GraphView(props: GraphProps) {
    return <ReactFlowProvider><Canvas {...props} /></ReactFlowProvider>;
}

function Canvas({ index, dependencies, layout, selected, onSelect, onMoved, onEdit }: GraphProps) {
    const [problem, setProblem] = useState<string>();
    const run = async (operation: EditOperation) => setProblem((await onEdit(operation)).join(' '));

    /** Dragging from one declaration to a type adds a field that references the type. */
    const connect = (from: string | null, to: string | null) => {
        const [source, target] = [from && index.nodes.get(from), to && index.nodes.get(to)];
        if (!source || !target || !HOLDERS.has(source.kind) || !TYPES.has(target.kind)) return;
        const name = target.qn.slice(target.qn.lastIndexOf('.') + 1);
        const reference = target.module === source.module ? name : target.qn;
        run({ op: 'add', parent: source.qn, source: `${name[0].toLowerCase()}${name.slice(1)}: ${reference}` });
    };
    const flow = useReactFlow();
    const [level, setLevel] = useState<Level>('medium');
    const current = useMemo(() => view(index, dependencies, level), [index, dependencies, level]);
    const saved = layout.positions?.[level];
    const [boxes, setBoxes] = useState<Map<string, Box>>();
    const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);

    useEffect(() => {
        let live = true;
        layoutView(current, saved ?? {}).then(result => live && setBoxes(result));
        return () => { live = false; };
    }, [current, saved]);

    useEffect(() => {
        if (!boxes) return;
        const shown = shownFor(selected, current, index);
        const place = (qn: string) => {
            const box = boxes.get(qn)!;
            return { position: { x: box.x, y: box.y }, parentId: box.parent, extent: box.parent ? 'parent' as const : undefined };
        };
        setNodes([
            ...current.groups.filter(g => boxes.has(g.qn)).map(g => ({
                id: g.qn, type: 'module', ...place(g.qn), style: { width: boxes.get(g.qn)!.width, height: boxes.get(g.qn)!.height },
                data: { card: g, selected: shown.card === g.qn, onSelect }
            })),
            ...current.cards.filter(c => boxes.has(c.qn)).map(c => ({
                id: c.qn, type: 'card', ...place(c.qn), data: { card: c, selected: shown.card === c.qn, row: shown.row, onSelect }
            }))
        ]);
    }, [boxes, selected, current, index, onSelect, setNodes]);

    const edges: Edge[] = useMemo(() => current.links.map(l => ({
        id: l.id, source: l.from, target: l.to, label: l.label,
        markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--line-strong)' },
        style: { stroke: 'var(--line-strong)' }, labelStyle: { fill: 'var(--ink-muted)', fontSize: 11 }, labelBgStyle: { fill: 'var(--surface)' }
    })), [current]);

    return (
        <div className="graph-canvas">
            <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                onNodesChange={onNodesChange}
                onNodeClick={(_, node) => onSelect(node.id)}
                onNodeDragStop={(_, node) => onMoved(level, node.id, node.position)}
                onConnect={connection => connect(connection.source, connection.target)}
                nodesConnectable={level !== 'out'}
                deleteKeyCode="Delete"
                onBeforeDelete={async ({ nodes: removed }) => {
                    for (const node of removed) await run({ op: 'remove', target: node.id });
                    return false;
                }}
                onMove={(_, viewport) => setLevel(levelForZoom(viewport.zoom))}
                defaultViewport={{ x: 40, y: 40, zoom: ZOOM.medium }}
                minZoom={0.1}
                maxZoom={2.5}
                proOptions={{ hideAttribution: true }}
            >
                <Background color="var(--line)" gap={24} />
                <Controls showInteractive={false} />
            </ReactFlow>
            {problem && <div className="graph-problem" role="alert" onClick={() => setProblem(undefined)}>{problem}</div>}
            <div className="levels" role="group" aria-label="Zoom level">
                {(['out', 'medium', 'in'] as Level[]).map(l => (
                    <button key={l} className={l === level ? 'active' : ''} onClick={() => flow.zoomTo(ZOOM[l], { duration: 300 })}>
                        {l === 'out' ? 'Modules' : l === 'medium' ? 'Declarations' : 'Members'}
                    </button>
                ))}
            </div>
        </div>
    );
}

function CardNode({ data }: NodeProps<Node<CardData>>) {
    const { card, selected, row, onSelect } = data;
    return (
        <div className={`card layer-${card.layer}${selected ? ' selected' : ''}`} style={{ width: CARD_WIDTH }}>
            <Handle type="target" position={Position.Left} />
            <div className="card-title"><span className="card-layer">{card.layer}</span>{card.title}</div>
            {card.rows.length > 0 && (
                <ul className="card-rows">
                    {card.rows.map(r => (
                        <li key={r.qn} className={r.qn === row ? 'selected' : ''} onClick={event => { event.stopPropagation(); onSelect(r.qn); }}>{r.text}</li>
                    ))}
                </ul>
            )}
            <Handle type="source" position={Position.Right} />
        </div>
    );
}

function ModuleNode({ data }: NodeProps<Node<CardData>>) {
    return <div className={`module-group${data.selected ? ' selected' : ''}`}><div className="module-title">module {data.card.qn}</div></div>;
}

import { useEffect, useMemo, useState } from 'react';
import {
    Background, Controls, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, useReactFlow,
    type Edge, type Node, type NodeProps
} from '@xyflow/react';
import { ENTITY_WIDTH, layoutView, type Box } from '../layout.js';
import { entityView, shownFor, type EntityCard, type GraphIndex, type ViewSettings } from '../views.js';

interface GraphProps {
    index: GraphIndex;
    /** Only these entities or modules and what is associated with them. */
    focus?: string[];
    selected?: string;
    settings: ViewSettings;
    onSelect(qn: string): void;
    onSettings(settings: ViewSettings): void;
}

type EntityData = { entity: EntityCard, selected: boolean, dimmed: boolean, settings: ViewSettings };
type ModuleData = { qn: string, selected: boolean };

const nodeTypes = { entity: EntityNode, module: ModuleNode };

export function EntityCanvas(props: GraphProps) {
    return <ReactFlowProvider><Canvas {...props} /></ReactFlowProvider>;
}

function Canvas({ index, focus, selected, settings, onSelect, onSettings }: GraphProps) {
    const flow = useReactFlow();
    const [fitting, setFitting] = useState(true);
    const { linkEntities, emptyModules, direction } = settings;
    const current = useMemo(() => entityView(index, { linkEntities, emptyModules, focus }), [index, linkEntities, emptyModules, focus]);
    const [boxes, setBoxes] = useState<Map<string, Box>>();
    useEffect(() => setFitting(true), [linkEntities, emptyModules, direction, focus]);

    useEffect(() => {
        let live = true;
        layoutView(current, direction).then(result => live && setBoxes(result));
        return () => { live = false; };
    }, [current, direction]);

    const shown = shownFor(selected, current, index);
    /** With focus on, the selected entity and the entities associated with it; everything when no entity is selected. */
    const near = useMemo(() => {
        if (!settings.focus || !current.entities.some(e => e.qn === shown)) return undefined;
        return new Set([shown!, ...current.associations.filter(a => a.from === shown || a.to === shown).flatMap(a => [a.from, a.to])]);
    }, [settings.focus, current, shown]);

    const nodes: Node[] = useMemo(() => {
        if (!boxes) return [];
        const place = (qn: string) => {
            const box = boxes.get(qn)!;
            return { position: { x: box.x, y: box.y }, parentId: box.parent, extent: box.parent ? 'parent' as const : undefined };
        };
        return [
            ...current.modules.filter(m => boxes.has(m.qn)).map(m => ({
                id: m.qn, type: 'module', ...place(m.qn), style: { width: boxes.get(m.qn)!.width, height: boxes.get(m.qn)!.height },
                data: { qn: m.qn, selected: shown === m.qn }
            })),
            ...current.entities.filter(e => boxes.has(e.qn)).map(e => ({
                id: e.qn, type: 'entity', ...place(e.qn), data: { entity: e, selected: shown === e.qn, dimmed: near ? !near.has(e.qn) : false, settings }
            }))
        ];
    }, [boxes, current, shown, near, settings]);

    /** After the first layout and after the shown entities or the direction change, fit the whole view. */
    useEffect(() => {
        if (!fitting || !nodes.length) return;
        setFitting(false);
        requestAnimationFrame(() => flow.fitView({ padding: 0.15, duration: 300 }));
    }, [nodes, fitting, flow]);

    const edges: Edge[] = useMemo(() => current.associations.map(a => {
        const dimmed = near && !(a.from === shown || a.to === shown);
        return {
            id: a.id, source: a.from, target: a.to, type: settings.edges, label: settings.labels ? a.label : undefined,
            markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--line-strong)' },
            style: { stroke: 'var(--line-strong)', opacity: dimmed ? 0.15 : 1 },
            labelStyle: { fill: 'var(--ink-muted)', fontSize: 11, opacity: dimmed ? 0.15 : 1 }, labelBgStyle: { fill: 'var(--surface)', opacity: dimmed ? 0.15 : 1 }
        };
    }), [current, settings.edges, settings.labels, near, shown]);

    const links = index.graph.nodes.filter(n => n.kind === 'Entity' && n.props.link).length;
    const toggle = (key: 'linkEntities' | 'emptyModules' | 'labels' | 'actionCounts' | 'focus', label: string) => (
        <label><input type="checkbox" checked={settings[key]} onChange={e => onSettings({ ...settings, [key]: e.target.checked })} />{label}</label>
    );

    return (
        <div className="graph-canvas">
            <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                onNodeClick={(_, node) => onSelect(node.id)}
                nodesDraggable={false}
                nodesConnectable={false}
                deleteKeyCode={null}
                minZoom={0.1}
                maxZoom={2.5}
                proOptions={{ hideAttribution: true }}
            >
                <Background color="var(--line)" gap={24} />
                <Controls showInteractive={false} />
            </ReactFlow>
            <details className="view-options">
                <summary>View</summary>
                <fieldset>
                    <legend>Show</legend>
                    {toggle('linkEntities', `Link entities (${links} in the model)`)}
                    {toggle('emptyModules', 'Modules without entities')}
                    {toggle('labels', 'Field names on arrows')}
                    {toggle('actionCounts', 'Action count on entities')}
                    {toggle('focus', 'Focus on the selected entity')}
                </fieldset>
                <fieldset>
                    <legend>Layout</legend>
                    <label>Direction
                        <select value={settings.direction} onChange={e => onSettings({ ...settings, direction: e.target.value as ViewSettings['direction'] })}>
                            <option value="RIGHT">Left to right</option>
                            <option value="DOWN">Top to bottom</option>
                        </select>
                    </label>
                    <label>Arrows
                        <select value={settings.edges} onChange={e => onSettings({ ...settings, edges: e.target.value as ViewSettings['edges'] })}>
                            <option value="default">Curved</option>
                            <option value="smoothstep">Right angled</option>
                            <option value="straight">Straight</option>
                        </select>
                    </label>
                </fieldset>
            </details>
        </div>
    );
}

function EntityNode({ data }: NodeProps<Node<EntityData>>) {
    const { entity, selected, dimmed, settings } = data;
    const [target, source] = settings.direction === 'DOWN' ? [Position.Top, Position.Bottom] : [Position.Left, Position.Right];
    return (
        <div className={`entity${entity.link ? ' link' : ''}${selected ? ' selected' : ''}${dimmed ? ' dimmed' : ''}`} style={{ width: ENTITY_WIDTH }}>
            <Handle type="target" position={target} isConnectable={false} />
            <span className="entity-name">{entity.name}</span>
            {entity.link && <span className="entity-tag">link</span>}
            {settings.actionCounts && entity.actions > 0 && <span className="entity-tag">{entity.actions} action{entity.actions === 1 ? '' : 's'}</span>}
            <Handle type="source" position={source} isConnectable={false} />
        </div>
    );
}

function ModuleNode({ data }: NodeProps<Node<ModuleData>>) {
    return <div className={`module-group${data.selected ? ' selected' : ''}`}><div className="module-title">module {data.qn}</div></div>;
}
